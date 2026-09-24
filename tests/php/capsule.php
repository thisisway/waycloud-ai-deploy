<?php
declare(strict_types=1);

// Runs the Store contract against CapsuleStore on the real Laravel query builder (SQLite in memory):
//   docker run --rm -v "$PWD":/app -w /app php:8.1-cli php tests/php/capsule.php
// (needs `composer install` in tests/php, see composer.json)

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/../../whmcs/modules/addons/waycloud_ai/lib/autoload.php';
require __DIR__ . '/Fakes.php';

use Illuminate\Database\Capsule\Manager;
use WayCloud\Ai\CapsuleStore;
use WayCloud\Ai\Schema;
use WayCloud\Ai\Store;

// WHMCS\Database\Capsule extends Illuminate's Capsule Manager; alias it for this test.
class_alias(Manager::class, 'WHMCS\\Database\\Capsule');
$cap = new Manager();
$cap->addConnection(['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
$cap->setAsGlobal();

$failures = 0;
$total = 0;
function check(string $name, callable $fn): void
{
    global $failures, $total;
    $total++;
    try {
        $fn();
        echo "  ok    $name\n";
    } catch (Throwable $e) {
        $failures++;
        echo "  FAIL  $name\n        " . $e->getMessage() . "\n";
    }
}
function same(mixed $expected, mixed $actual, string $what = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(($what !== '' ? "$what: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

function contract(string $label, Store $s): void
{
    echo "$label\n";
    $row = static fn (array $o = []): array => $o + ['token_hash' => bin2hex(random_bytes(16)), 'session_id' => '6f1c2d3e-0000-4000-8000-0123456789ab', 'pid' => 173, 'cycle' => 'monthly', 'domain' => 'a.sites.test', 'status' => 'new', 'expires_at' => 2000, 'created_at' => 1000, 'updated_at' => 1000];

    check('create and find by token hash, id, invoice and service', function () use ($s, $row) {
        $id = $s->createCheckout($row(['token_hash' => 'h1']));
        same($id, (int) $s->findCheckoutByTokenHash('h1')['id']);
        same(null, $s->findCheckoutByTokenHash('nope'));
        $s->updateCheckout($id, ['invoice_id' => 77, 'service_id' => 88]);
        same($id, (int) $s->findCheckoutBy('invoice_id', 77)['id']);
        same($id, (int) $s->findCheckoutBy('service_id', 88)['id']);
        same(null, $s->findCheckoutBy('invoice_id', 12345));
    });
    check('updateCheckout is a compare-and-set', function () use ($s, $row) {
        $id = $s->createCheckout($row(['token_hash' => 'h2']));
        same(true, $s->updateCheckout($id, ['status' => 'ordering'], ['new', 'client_created']), 'first claim wins');
        same(false, $s->updateCheckout($id, ['status' => 'ordering'], ['new', 'client_created']), 'second claim loses');
        same('ordering', $s->findCheckoutByTokenHash('h2')['status']);
        same(true, $s->updateCheckout($id, ['status' => 'ordered']), 'unconditional update');
    });
    check('cancelOpenCheckouts only touches open checkouts of that session', function () use ($s, $row) {
        $sess = 'aaaaaaaa-0000-4000-8000-000000000001';
        $open = $s->createCheckout($row(['token_hash' => 'h3', 'session_id' => $sess]));
        $paid = $s->createCheckout($row(['token_hash' => 'h4', 'session_id' => $sess, 'status' => 'paid']));
        $other = $s->createCheckout($row(['token_hash' => 'h5', 'session_id' => 'bbbbbbbb-0000-4000-8000-000000000002']));
        $s->cancelOpenCheckouts($sess);
        same('cancelled', $s->findCheckoutBy('id', $open)['status']);
        same('paid', $s->findCheckoutBy('id', $paid)['status']);
        same('new', $s->findCheckoutBy('id', $other)['status']);
    });
    check('plan map round trip with integer pids', function () use ($s) {
        $s->savePlanMap(['static' => 173, 'php' => 174]);
        same(['static' => 173, 'php' => 174], $s->planMap());
        $s->savePlanMap(['static' => 999]);
        same(['static' => 999], $s->planMap());
    });
    check('nonces: recorded once, purged when old', function () use ($s) {
        same(true, $s->recordNonce('nonce-A', 100));
        same(false, $s->recordNonce('nonce-A', 101), 'replay');
        $s->purgeNonces(200);
        same(true, $s->recordNonce('nonce-A', 300), 'purged nonce can be seen again');
    });
    check('outbox: due, sent, failed with backoff, pending count', function () use ($s) {
        $before = $s->pendingOutbox();
        $id = $s->queueEvent('order.paid', ['session_id' => 'x'], 1000);
        same($before + 1, $s->pendingOutbox());
        $due = array_values(array_filter($s->dueEvents(1000, 50), fn ($e) => (int) $e['id'] === $id));
        same(1, count($due));
        same(['order.paid', ['session_id' => 'x'], 0], [$due[0]['event'], json_decode((string) $due[0]['payload'], true), (int) $due[0]['attempts']]);
        $s->markEventFailed($id, 2, 1500);
        same(0, count(array_filter($s->dueEvents(1499, 50), fn ($e) => (int) $e['id'] === $id)), 'not due before backoff');
        same(1, count(array_filter($s->dueEvents(1500, 50), fn ($e) => (int) $e['id'] === $id)), 'due after backoff');
        $s->markEventSent($id, 1600);
        same(0, count(array_filter($s->dueEvents(9999, 50), fn ($e) => (int) $e['id'] === $id)), 'sent events are never due');
        same($before, $s->pendingOutbox());
    });
    check('events log and recent lists never expose the token hash', function () use ($s) {
        $s->logEvent('checkout.created', '1', ['pid' => 173], 1000);
        same(true, count($s->recentEvents(5)) >= 1);
        $recent = $s->recentCheckouts(50);
        same(true, count($recent) >= 1);
        foreach ($recent as $r) {
            same(false, array_key_exists('token_hash', $r), 'token_hash must not be listed');
        }
    });
}

contract('MemoryStore (reference)', new MemoryStore());

Schema::install();
Schema::install(); // idempotent
contract('CapsuleStore on illuminate/database (SQLite)', new CapsuleStore());

echo "\n" . ($total - $failures) . "/$total passed\n";
exit($failures === 0 ? 0 : 1);
