<?php
declare(strict_types=1);

namespace WayCloud\Ai;

use WHMCS\Database\Capsule;

/**
 * WhmcsApi on top of localAPI() (runs inside WHMCS, no credentials involved).
 * Parameter names follow the WHMCS 8.x API documentation; anything marked "verify" was not
 * exercised against a live WHMCS yet and is covered by the admin Diagnostics page.
 */
final class LocalWhmcsApi implements WhmcsApi
{
    private Settings $settings;

    public function __construct(?Settings $settings = null)
    {
        $this->settings = $settings ?? Settings::fromWhmcs();
    }

    /** @param array<string,mixed> $values @return array<string,mixed> @throws WhmcsApiError */
    private function call(string $command, array $values = []): array
    {
        /** @var array<string,mixed> $r */
        $r = localAPI($command, $values);
        if (($r['result'] ?? '') !== 'success') {
            throw new WhmcsApiError((string) ($r['message'] ?? 'unknown WHMCS API error'));
        }
        return $r;
    }

    public function systemUrl(): string
    {
        return (string) \WHMCS\Config\Setting::getValue('SystemURL');
    }

    public function findClientIdByEmail(string $email): ?int
    {
        try {
            $r = $this->call('GetClientsDetails', ['email' => $email]);
        } catch (WhmcsApiError) {
            return null; // "Client Not Found"
        }
        $id = (int) ($r['userid'] ?? $r['client']['userid'] ?? $r['client']['id'] ?? 0);
        return $id > 0 ? $id : null;
    }

    public function currentClientId(): ?int
    {
        try {
            if (class_exists('\WHMCS\Authentication\CurrentUser')) { // verify: WHMCS 8 API
                $client = (new \WHMCS\Authentication\CurrentUser())->client();
                return $client ? (int) $client->id : null;
            }
            $uid = \WHMCS\Session::get('uid');
            return $uid ? (int) $uid : null;
        } catch (\Throwable) {
            return null;
        }
    }

    public function addClient(array $data): int
    {
        return (int) $this->call('AddClient', $data)['clientid'];
    }

    public function addOrder(int $clientId, int $pid, string $cycle, string $domain, string $paymentMethod): array
    {
        $r = $this->call('AddOrder', [
            'clientid' => $clientId,
            'paymentmethod' => $paymentMethod,
            'pid' => [$pid],
            'billingcycle' => [$cycle],
            'domain' => [$domain],
        ]);
        $serviceIds = array_filter(explode(',', (string) ($r['serviceids'] ?? '')));
        return [
            'orderid' => (int) $r['orderid'],
            'invoiceid' => (int) ($r['invoiceid'] ?? 0),
            'serviceid' => (int) (reset($serviceIds) ?: 0),
        ];
    }

    public function createSsoUrl(int $clientId, string $path): ?string
    {
        try {
            $r = $this->call('CreateSsoToken', ['client_id' => $clientId, 'destination' => 'sso:custom_redirect', 'sso_redirect_path' => $path]); // verify
            return isset($r['redirect_url']) ? (string) $r['redirect_url'] : null;
        } catch (WhmcsApiError) {
            return null;
        }
    }

    public function clientCustomFieldIds(): array
    {
        $ids = [];
        foreach (Capsule::table('tblcustomfields')->where('type', 'client')->get(['id', 'fieldname']) as $f) {
            $name = trim(explode('|', (string) $f->fieldname)[0]); // WHMCS stores "internal|display"
            $ids[$name] = (int) $f->id;
        }
        return $ids;
    }

    public function requiredClientFieldNames(): array
    {
        $names = [];
        foreach (Capsule::table('tblcustomfields')->where('type', 'client')->where('required', 'on')->get(['fieldname']) as $f) {
            $names[] = trim(explode('|', (string) $f->fieldname)[0]);
        }
        return $names;
    }

    public function productInfo(int $pid): ?array
    {
        try {
            $r = $this->call('GetProducts', ['pid' => $pid]);
        } catch (WhmcsApiError) {
            return null;
        }
        $p = $r['products']['product'][0] ?? null;
        if (!is_array($p)) {
            return null;
        }
        $prices = $p['pricing']['BRL'] ?? (is_array($p['pricing'] ?? null) ? reset($p['pricing']) : []);
        $cents = static fn ($v): int => max(0, (int) round(((float) $v) * 100));
        return ['pid' => $pid, 'name' => (string) $p['name'], 'monthly_cents' => $cents($prices['monthly'] ?? 0), 'annual_cents' => $cents($prices['annually'] ?? 0)];
    }

    public function paymentModules(): array
    {
        try {
            $r = $this->call('GetPaymentMethods');
        } catch (WhmcsApiError) {
            return [];
        }
        return array_map(static fn (array $m): string => (string) $m['module'], $r['paymentmethods']['paymentmethod'] ?? []);
    }

    public function adminAlert(string $subject, string $message): void
    {
        logActivity('Way Cloud AI: ' . $subject . ' - ' . $message);
        try {
            localAPI('SendAdminEmail', ['customsubject' => $subject, 'custommessage' => nl2br(htmlspecialchars($message)), 'type' => 'system']); // verify
        } catch (\Throwable) {
        }
        $to = $this->settings->get('alert_email');
        if ($to !== '') {
            @mail($to, '[Way Cloud AI] ' . $subject, $message);
        }
    }
}
