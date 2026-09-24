<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * Persistence used by the addon. Two implementations on purpose: CapsuleStore (WHMCS database)
 * and an in-memory one for the tests. Timestamps are unix seconds.
 *
 * Checkout statuses: new -> client_created -> ordering -> ordered -> paid -> active | failed
 *                    (also: expired, cancelled)
 */
interface Store
{
    /** @param array<string,mixed> $row */
    public function createCheckout(array $row): int;

    /** @return array<string,mixed>|null */
    public function findCheckoutByTokenHash(string $hash): ?array;

    /** @return array<string,mixed>|null  $column is one of: id, invoice_id, service_id */
    public function findCheckoutBy(string $column, int $value): ?array;

    /**
     * Updates a checkout; when $onlyIfStatus is given the update applies only if the current status
     * is in that list (compare-and-set). Returns whether a row was changed.
     *
     * @param array<string,mixed> $fields
     * @param list<string>|null $onlyIfStatus
     */
    public function updateCheckout(int $id, array $fields, ?array $onlyIfStatus = null): bool;

    /** Cancels still-open checkouts of a session so only the latest link works. */
    public function cancelOpenCheckouts(string $sessionId): void;

    /** @return array<string,int> type (static|php) => WHMCS product id */
    public function planMap(): array;

    /** @param array<string,int> $map */
    public function savePlanMap(array $map): void;

    /** Records a nonce; false when it was already seen (replay). */
    public function recordNonce(string $nonce, int $ts): bool;

    public function purgeNonces(int $olderThan): void;

    /** @param array<string,mixed> $payload */
    public function queueEvent(string $event, array $payload, int $now): int;

    /** @return list<array<string,mixed>> */
    public function dueEvents(int $now, int $limit): array;

    public function markEventSent(int $id, int $now): void;

    public function markEventFailed(int $id, int $attempts, int $nextAttemptAt): void;

    /** @param array<string,mixed> $data Never put personal data here. */
    public function logEvent(string $type, ?string $ref, array $data, int $now): void;

    /** @return list<array<string,mixed>> */
    public function recentCheckouts(int $limit): array;

    /** @return list<array<string,mixed>> */
    public function recentEvents(int $limit): array;

    public function pendingOutbox(): int;
}
