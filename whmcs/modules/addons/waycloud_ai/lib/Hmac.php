<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * HMAC-SHA256 over "<timestamp>.<nonce>.<body>", the same scheme the Node service uses
 * (apps/mcp-service/src/security/hmac.ts). A shared test vector keeps both sides identical.
 */
final class Hmac
{
    public const MIN_SECRET_LENGTH = 32;

    public static function mac(string $secret, int $ts, string $nonce, string $body): string
    {
        return hash_hmac('sha256', $ts . '.' . $nonce . '.' . $body, $secret);
    }

    /** @return array{ts:int, nonce:string, signature:string} */
    public static function sign(string $secret, string $body, ?int $ts = null, ?string $nonce = null): array
    {
        $ts ??= time();
        $nonce ??= bin2hex(random_bytes(16));
        return ['ts' => $ts, 'nonce' => $nonce, 'signature' => self::mac($secret, $ts, $nonce, $body)];
    }

    /**
     * Order matters: secret configured, timestamp window, signature, and only a VALID signature
     * burns a nonce (an attacker cannot fill the nonce table with junk).
     *
     * @return string ok | not_configured | expired | bad_signature | replay
     */
    public static function verify(Store $store, string $secret, int $ts, string $nonce, string $signature, string $body, ?int $now = null, int $window = 300): string
    {
        // An empty or short secret would let anyone forge requests.
        if (strlen($secret) < self::MIN_SECRET_LENGTH) {
            return 'not_configured';
        }
        $now ??= time();
        if (abs($now - $ts) > $window) {
            return 'expired';
        }
        if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $nonce)) {
            return 'bad_signature';
        }
        if (!hash_equals(self::mac($secret, $ts, $nonce, $body), strtolower($signature))) {
            return 'bad_signature';
        }
        return $store->recordNonce($nonce, $now) ? 'ok' : 'replay';
    }
}
