<?php
declare(strict_types=1);

// Router for `php -S`: serves the REAL WayCloud\Ai\Api (HMAC, routing, Checkout) on in-memory fakes,
// so the Node service can be tested against the actual PHP code:
//   docker run --rm -p 18081:8080 -v "$PWD":/app -w /app -e ADDON_HMAC_SECRET=... php:8.1-cli php -S 0.0.0.0:8080 tests/php/server.php
// Every request is a fresh PHP process, so nonces live in a temp file to make replay detection observable.

require __DIR__ . '/../../whmcs/modules/addons/waycloud_ai/lib/autoload.php';
require __DIR__ . '/Fakes.php';

use WayCloud\Ai\Api;
use WayCloud\Ai\Checkout;
use WayCloud\Ai\McpNotifier;
use WayCloud\Ai\Settings;

final class FileNonceStore extends MemoryStore
{
    public function recordNonce(string $nonce, int $ts): bool
    {
        $file = sys_get_temp_dir() . '/waycloud-test-nonces.json';
        $seen = is_file($file) ? (array) json_decode((string) file_get_contents($file), true) : [];
        if (isset($seen[$nonce])) {
            return false;
        }
        $seen[$nonce] = $ts;
        file_put_contents($file, json_encode($seen));
        return true;
    }
}

$store = new FileNonceStore();
$whmcs = new FakeWhmcs();
$whmcs->systemUrl = getenv('SYSTEM_URL') ?: 'http://127.0.0.1:18081/';
$settings = new Settings(['hmac_secret' => (string) getenv('ADDON_HMAC_SECRET')]);
$now = static fn (): int => time();
$notifier = new McpNotifier($store, $settings, static fn (): int => 0, $now);
$api = new Api($store, $settings, new Checkout($store, $whmcs, $settings, $notifier, $now, static fn (int $n): string => random_bytes($n)), $whmcs, $now);

[$status, $body] = $api->handle(
    (string) $_SERVER['REQUEST_METHOD'],
    [
        'x-waycloud-timestamp' => (string) ($_SERVER['HTTP_X_WAYCLOUD_TIMESTAMP'] ?? ''),
        'x-waycloud-nonce' => (string) ($_SERVER['HTTP_X_WAYCLOUD_NONCE'] ?? ''),
        'x-waycloud-signature' => (string) ($_SERVER['HTTP_X_WAYCLOUD_SIGNATURE'] ?? ''),
    ],
    (string) file_get_contents('php://input'),
);
http_response_code($status);
header('Content-Type: application/json; charset=utf-8');
echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
