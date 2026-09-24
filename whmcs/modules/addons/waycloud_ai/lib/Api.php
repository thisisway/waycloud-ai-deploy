<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** HTTP surface used by the MCP service (api.php only bootstraps WHMCS and calls this). */
final class Api
{
    /** @param \Closure(): int $now */
    public function __construct(
        private Store $store,
        private Settings $settings,
        private Checkout $checkout,
        private WhmcsApi $whmcs,
        private \Closure $now,
    ) {
    }

    /**
     * @param array<string,string> $headers lower-case header names
     * @return array{0:int, 1:array<string,mixed>} status and JSON body
     */
    public function handle(string $method, array $headers, string $rawBody): array
    {
        if ($method !== 'POST') {
            return [405, ['error' => 'method_not_allowed']];
        }
        $now = ($this->now)();
        $verdict = Hmac::verify(
            $this->store,
            $this->settings->get('hmac_secret'),
            (int) ($headers['x-waycloud-timestamp'] ?? 0),
            (string) ($headers['x-waycloud-nonce'] ?? ''),
            (string) ($headers['x-waycloud-signature'] ?? ''),
            $rawBody,
            $now,
        );
        if ($verdict !== 'ok') {
            try {
                $this->store->logEvent('api.rejected', null, ['reason' => $verdict], $now);
            } catch (\Throwable) {
                // the answer to a rejected request must not depend on the log (e.g. tables not created yet)
            }
            return [401, ['error' => 'unauthorized']]; // never say why
        }
        if (random_int(1, 50) === 1) {
            $this->store->purgeNonces($now - 600);
        }

        $data = json_decode($rawBody, true);
        if (!is_array($data)) {
            return [400, ['error' => 'invalid_json']];
        }
        try {
            switch ($data['action'] ?? '') {
                case 'ping':
                    return [200, ['ok' => true]];
                case 'create_checkout':
                    return [200, $this->checkout->createFromMcp($data)];
                case 'plans':
                    return [200, ['plans' => $this->plans()]];
                default:
                    return [400, ['error' => 'unknown_action']];
            }
        } catch (ApiException $e) {
            return [$e->status, ['error' => $e->errorCode]];
        }
    }

    /** @return list<array{type:string, pid:int, name:string, monthly_cents:int, annual_cents:int}> */
    private function plans(): array
    {
        $out = [];
        foreach ($this->store->planMap() as $type => $pid) {
            $info = $this->whmcs->productInfo($pid);
            if ($info !== null) {
                $out[] = ['type' => $type, 'pid' => $pid, 'name' => $info['name'], 'monthly_cents' => $info['monthly_cents'], 'annual_cents' => $info['annual_cents']];
            }
        }
        return $out;
    }
}
