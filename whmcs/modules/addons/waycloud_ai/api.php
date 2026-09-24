<?php
declare(strict_types=1);

/**
 * Signed HTTP endpoint used by the Way Cloud MCP service:
 *   POST https://<whmcs>/modules/addons/waycloud_ai/api.php
 *   headers X-WayCloud-Timestamp / X-WayCloud-Nonce / X-WayCloud-Signature (HMAC-SHA256)
 * Everything happens in WayCloud\Ai\Api; this file only bootstraps WHMCS.
 */

require_once __DIR__ . '/../../../init.php';
require_once __DIR__ . '/lib/autoload.php';

$headers = [
    'x-waycloud-timestamp' => (string) ($_SERVER['HTTP_X_WAYCLOUD_TIMESTAMP'] ?? ''),
    'x-waycloud-nonce' => (string) ($_SERVER['HTTP_X_WAYCLOUD_NONCE'] ?? ''),
    'x-waycloud-signature' => (string) ($_SERVER['HTTP_X_WAYCLOUD_SIGNATURE'] ?? ''),
];

try {
    [$status, $body] = \WayCloud\Ai\Container::api()->handle(
        (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'),
        $headers,
        (string) file_get_contents('php://input'),
    );
} catch (\Throwable $e) {
    logActivity('Way Cloud AI api.php: ' . $e->getMessage());
    [$status, $body] = [500, ['error' => 'internal_error']]; // never leak details
}

http_response_code($status);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
