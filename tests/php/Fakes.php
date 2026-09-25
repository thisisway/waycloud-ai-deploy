<?php
declare(strict_types=1);

use WayCloud\Ai\Store;
use WayCloud\Ai\WhmcsApi;
use WayCloud\Ai\WhmcsApiError;

/** In-memory Store for tests. */
class MemoryStore implements Store
{
    /** @var array<int,array<string,mixed>> */
    public array $checkouts = [];
    /** @var array<string,int> */
    public array $plans = ['static' => 173, 'php' => 174];
    /** @var array<string,int> */
    public array $nonces = [];
    /** @var array<int,array<string,mixed>> */
    public array $outbox = [];
    /** @var list<array<string,mixed>> */
    public array $log = [];
    private int $seq = 0;

    public function createCheckout(array $row): int
    {
        $id = ++$this->seq;
        $this->checkouts[$id] = $row + ['id' => $id, 'client_id' => null, 'order_id' => null, 'invoice_id' => null, 'service_id' => null];
        return $id;
    }

    public function findCheckoutByTokenHash(string $hash): ?array
    {
        foreach ($this->checkouts as $c) {
            if ($c['token_hash'] === $hash) {
                return $c;
            }
        }
        return null;
    }

    public function findCheckoutBy(string $column, int $value): ?array
    {
        foreach ($this->checkouts as $c) {
            if ((int) ($c[$column] ?? 0) === $value) {
                return $c;
            }
        }
        return null;
    }

    public function updateCheckout(int $id, array $fields, ?array $onlyIfStatus = null): bool
    {
        if (!isset($this->checkouts[$id]) || ($onlyIfStatus !== null && !in_array($this->checkouts[$id]['status'], $onlyIfStatus, true))) {
            return false;
        }
        $this->checkouts[$id] = $fields + $this->checkouts[$id];
        return true;
    }

    public function cancelOpenCheckouts(string $sessionId): void
    {
        foreach ($this->checkouts as $id => $c) {
            if ($c['session_id'] === $sessionId && in_array($c['status'], ['new', 'client_created'], true)) {
                $this->checkouts[$id]['status'] = 'cancelled';
            }
        }
    }

    public function planMap(): array
    {
        return $this->plans;
    }

    public function savePlanMap(array $map): void
    {
        $this->plans = $map;
    }

    public function recordNonce(string $nonce, int $ts): bool
    {
        if (isset($this->nonces[$nonce])) {
            return false;
        }
        $this->nonces[$nonce] = $ts;
        return true;
    }

    public function purgeNonces(int $olderThan): void
    {
        $this->nonces = array_filter($this->nonces, static fn (int $t): bool => $t >= $olderThan);
    }

    public function queueEvent(string $event, array $payload, int $now): int
    {
        $id = count($this->outbox) + 1;
        $this->outbox[$id] = ['id' => $id, 'event' => $event, 'payload' => json_encode($payload), 'attempts' => 0, 'next_attempt_at' => $now, 'sent_at' => null];
        return $id;
    }

    public function dueEvents(int $now, int $limit): array
    {
        return array_slice(array_values(array_filter($this->outbox, static fn (array $e): bool => $e['sent_at'] === null && $e['next_attempt_at'] <= $now)), 0, $limit);
    }

    public function markEventSent(int $id, int $now): void
    {
        $this->outbox[$id]['sent_at'] = $now;
    }

    public function markEventFailed(int $id, int $attempts, int $nextAttemptAt): void
    {
        $this->outbox[$id]['attempts'] = $attempts;
        $this->outbox[$id]['next_attempt_at'] = $nextAttemptAt;
    }

    public function logEvent(string $type, ?string $ref, array $data, int $now): void
    {
        $this->log[] = ['type' => $type, 'ref' => $ref, 'data' => $data];
    }

    public function recentCheckouts(int $limit): array
    {
        $rows = array_map(static function (array $c): array {
            unset($c['token_hash']); // same as the real store: the hash is never listed
            return $c;
        }, array_reverse(array_values($this->checkouts)));
        return array_slice($rows, 0, $limit);
    }

    public function recentEvents(int $limit): array
    {
        return array_slice(array_reverse($this->log), 0, $limit);
    }

    public function pendingOutbox(): int
    {
        return count(array_filter($this->outbox, static fn (array $e): bool => $e['sent_at'] === null));
    }
}

/** Fake WHMCS: records every call and can be told to fail. */
final class FakeWhmcs implements WhmcsApi
{
    /** @var list<array{0:string,1:array<mixed>}> */
    public array $calls = [];
    /** @var array<string,int> email => client id */
    public array $clients = [];
    public ?int $loggedIn = null;
    public ?string $failAddClient = null;
    public ?string $failAddOrder = null;
    public ?string $failReset = null;
    /** Runs inside addClient: lets a test simulate a concurrent request winning the race. */
    public ?\Closure $afterAddClient = null;
    public ?string $sso = 'https://app.test/sso/abc';
    /** @var array<string,int> */
    public array $customFields = ['Tipo de documento' => 11, 'CPF/CNPJ' => 12, 'Celular' => 13];
    /** @var list<string> */
    public array $requiredFields = ['CPF/CNPJ', 'Celular'];
    /** @var list<string> */
    public array $alerts = [];
    private int $nextClient = 100;
    private int $nextOrder = 500;

    public string $systemUrl = 'https://app.test/';

    public function systemUrl(): string
    {
        return $this->systemUrl;
    }

    public function findClientIdByEmail(string $email): ?int
    {
        return $this->clients[strtolower($email)] ?? null;
    }

    public function currentClientId(): ?int
    {
        return $this->loggedIn;
    }

    public function addClient(array $data): int
    {
        $this->calls[] = ['addClient', $data];
        if ($this->failAddClient !== null) {
            throw new WhmcsApiError($this->failAddClient);
        }
        $id = $this->nextClient++;
        $this->clients[strtolower($data['email'])] = $id;
        if ($this->afterAddClient !== null) {
            ($this->afterAddClient)();
        }
        return $id;
    }

    public function addOrder(int $clientId, int $pid, string $cycle, string $domain, string $paymentMethod): array
    {
        $this->calls[] = ['addOrder', compact('clientId', 'pid', 'cycle', 'domain', 'paymentMethod')];
        if ($this->failAddOrder !== null) {
            throw new WhmcsApiError($this->failAddOrder);
        }
        $o = $this->nextOrder++;
        return ['orderid' => $o, 'invoiceid' => $o + 1000, 'serviceid' => $o + 2000];
    }

    public function sendPasswordReset(string $email): void
    {
        $this->calls[] = ['reset', [$email]];
        if ($this->failReset !== null) {
            throw new WhmcsApiError($this->failReset);
        }
    }

    public function createSsoUrl(int $clientId, string $path): ?string
    {
        $this->calls[] = ['sso', [$clientId, $path]];
        return $this->sso;
    }

    public function clientCustomFieldIds(): array
    {
        return $this->customFields;
    }

    public function requiredClientFieldNames(): array
    {
        return $this->requiredFields;
    }

    public function productInfo(int $pid): ?array
    {
        return ['pid' => $pid, 'name' => 'Speed BR (teste)', 'monthly_cents' => 3590, 'annual_cents' => 38770];
    }

    public function paymentModules(): array
    {
        return ['efipix', 'iugucartao'];
    }

    public function adminAlert(string $subject, string $message): void
    {
        $this->alerts[] = $subject . ' | ' . $message;
    }
}
