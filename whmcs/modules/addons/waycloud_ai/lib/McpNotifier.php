<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * Outbox: every event is stored first, then sent signed to the MCP service. A failure never loses
 * the event: it is retried with exponential backoff by flush() (called from the WHMCS cron hook).
 */
final class McpNotifier implements Notifier
{
    /**
     * @param \Closure(string, list<string>, string): int $post  url, header lines, body -> HTTP status (0 on network error)
     * @param \Closure(): int $now
     */
    public function __construct(private Store $store, private Settings $settings, private \Closure $post, private \Closure $now)
    {
    }

    public function queue(string $event, array $payload): void
    {
        $this->store->queueEvent($event, $payload, ($this->now)());
        $this->flush();
    }

    /** Sends every due event. Returns how many were delivered. */
    public function flush(int $limit = 20): int
    {
        $url = $this->settings->mcpUrl();
        $secret = $this->settings->get('hmac_secret');
        if ($url === '' || strlen($secret) < Hmac::MIN_SECRET_LENGTH) {
            return 0; // not configured yet: events wait in the outbox
        }
        $sent = 0;
        foreach ($this->store->dueEvents(($this->now)(), $limit) as $e) {
            $body = json_encode(
                ['id' => (int) $e['id'], 'event' => $e['event'], 'data' => json_decode((string) $e['payload'], true)],
                JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE,
            );
            $sig = Hmac::sign($secret, (string) $body, ($this->now)());
            $status = ($this->post)($url . '/webhooks/whmcs', [
                'Content-Type: application/json',
                'X-WayCloud-Timestamp: ' . $sig['ts'],
                'X-WayCloud-Nonce: ' . $sig['nonce'],
                'X-WayCloud-Signature: ' . $sig['signature'],
            ], (string) $body);
            $now = ($this->now)();
            if ($status >= 200 && $status < 300) {
                $this->store->markEventSent((int) $e['id'], $now);
                $sent++;
            } else {
                $attempts = (int) $e['attempts'] + 1;
                $this->store->markEventFailed((int) $e['id'], $attempts, $now + min(3600, 30 * (2 ** $attempts)));
            }
        }
        return $sent;
    }
}
