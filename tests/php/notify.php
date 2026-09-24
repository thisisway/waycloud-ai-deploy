<?php
declare(strict_types=1);

// Drives the REAL addon classes (Checkout + McpNotifier + Http::post over curl) through a whole purchase,
// sending signed webhooks to the Node service. Used by tests/integration/php-to-node.test.ts (needs Docker):
// phase 1 the MCP URL is unreachable (events must wait in the outbox), phase 2 it is up and the retry delivers them.

require __DIR__ . '/../../whmcs/modules/addons/waycloud_ai/lib/autoload.php';
require __DIR__ . '/Fakes.php';

use WayCloud\Ai\Checkout;
use WayCloud\Ai\Http;
use WayCloud\Ai\McpNotifier;
use WayCloud\Ai\Settings;

$secret = (string) getenv('ADDON_HMAC_SECRET');
$session = (string) getenv('SESSION_ID');
$goodUrl = (string) getenv('MCP_URL');

$store = new MemoryStore();
$whmcs = new FakeWhmcs();
$clock = new class { public int $t; public function __construct() { $this->t = time(); } };
$now = static fn (): int => $clock->t;
$statuses = [];
$post = static function (string $url, array $headers, string $body) use (&$statuses): int {
    $status = Http::post($url, $headers, $body);
    $statuses[] = $status;
    return $status;
};
$mk = static fn (string $url): McpNotifier => new McpNotifier($store, new Settings(['mcp_url' => $url, 'hmac_secret' => $secret]), $post, $now);

// Phase 1: the MCP service is unreachable.
$down = $mk('http://127.0.0.1:1');
$checkout = new Checkout($store, $whmcs, new Settings(['mcp_url' => 'http://127.0.0.1:1', 'hmac_secret' => $secret]), $down, $now, static fn (int $n): string => random_bytes($n));
$link = $checkout->createFromMcp(['session_id' => $session, 'pid' => 173, 'cycle' => 'monthly']);
preg_match('/t=([A-Za-z0-9_-]+)$/', $link['checkout_url'], $m);
$r = $checkout->submit($m[1], [
    'nome' => 'Maria da Silva', 'email' => 'maria@example.com', 'doc_tipo' => 'CPF', 'doc_numero' => '529.982.247-25',
    'telefone' => '(11) 99999-8888', 'senha' => 'S3nha-forte!', 'aceite' => '1', 'website' => '',
]);
$checkout->onInvoicePaid(1500);
$checkout->onModuleCreated(2500, ['server_id' => 18]);
$pendingAfterFailure = $store->pendingOutbox();

// Phase 2: the service is back and the backoff has elapsed. The events are made due directly: moving the
// clock would also move the signed timestamp, which the receiver (rightly) refuses beyond 5 minutes.
foreach ($store->outbox as $id => $_) {
    $store->outbox[$id]['next_attempt_at'] = 0;
}
$sent = $mk($goodUrl)->flush(50);

echo json_encode(['submit_ok' => $r['ok'], 'pending_after_failure' => $pendingAfterFailure, 'sent_on_retry' => $sent, 'pending_after_retry' => $store->pendingOutbox(), 'http_statuses' => $statuses]);
