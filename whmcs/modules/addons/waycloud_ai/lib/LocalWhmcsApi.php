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
            // The customer goes straight to the invoice page: the order and "invoice available" e-mails only slow the request (about 15 s of SMTP and Pix generation).
            'noemail' => true,
            'noinvoiceemail' => true,
        ]);
        $serviceIds = array_filter(explode(',', (string) ($r['serviceids'] ?? '')));
        return [
            'orderid' => (int) $r['orderid'],
            'invoiceid' => (int) ($r['invoiceid'] ?? 0),
            'serviceid' => (int) (reset($serviceIds) ?: 0),
        ];
    }

    public function updateServiceDomain(int $serviceId, string $domain): void
    {
        $this->call('UpdateClientProduct', ['serviceid' => $serviceId, 'domain' => $domain]); // verify: WHMCS API (changes the service's domain field only)
    }

    public function sendPasswordReset(string $email): void
    {
        // The customer is already waiting for the invoice page: send once the response is out (SMTP takes seconds).
        register_shutdown_function(function () use ($email): void {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            try {
                $this->call('ResetPassword', ['email' => $email]); // verify: WHMCS 8 API (ResetPassword sends the reset-validation e-mail)
            } catch (\Throwable $e) {
                logActivity('Way Cloud AI: e-mail de definição de senha não enviado - ' . $e->getMessage());
            }
        });
    }

    public function pixCharge(int $invoiceId): ?array
    {
        $inv = Capsule::table('tblinvoices')->where('id', $invoiceId)->first(['status', 'paymentmethod']);
        if ($inv === null || $inv->status !== 'Unpaid' || $inv->paymentmethod !== 'efipix') {
            return null;
        }
        try {
            $invoice = new \WHMCS\Invoice($invoiceId);
            $invoice->getData();
            $invoice->getPaymentLink(); // the gateway creates (or reuses) the charge while building its payment box
        } catch (\Throwable) {
            return null;
        }
        $c = Capsule::table('mod_efipix_charges')->where('invoice_id', $invoiceId)->where('status', 'ATIVA')->orderBy('id', 'desc')->first();
        if ($c === null || (string) $c->copy_paste === '') {
            return null;
        }
        return ['copy_paste' => (string) $c->copy_paste, 'qr_image' => (string) $c->qr_image, 'amount_cents' => (int) round(((float) $c->amount) * 100), 'expires_at' => (string) $c->expires_at];
    }

    public function invoiceForCharge(int $invoiceId): ?array
    {
        $inv = Capsule::table('tblinvoices')->where('id', $invoiceId)->first(['status', 'total', 'userid']);
        if ($inv === null) {
            return null;
        }
        $email = (string) Capsule::table('tblclients')->where('id', (int) $inv->userid)->value('email');
        return ['status' => (string) $inv->status, 'total_cents' => (int) round(((float) $inv->total) * 100), 'email' => $email];
    }

    public function chargeCard(int $invoiceId, string $email, int $totalCents, string $token, int $months): array
    {
        $apiToken = $this->settings->get('iugu_api_token');
        if ($apiToken === '') {
            return ['approved' => false, 'error_message' => 'Iugu API token não configurado.'];
        }
        [$status, $body] = Http::postJson('https://api.iugu.com/v1/charge?api_token=' . urlencode($apiToken), [
            'token' => $token,
            'email' => $email,
            'months' => max(1, $months),
            'items' => [[
                'description' => 'Fatura #' . $invoiceId . ' - Way Cloud',
                'quantity' => 1,
                'price_cents' => $totalCents,
            ]],
        ]);
        $data = json_decode($body, true);
        if ($status !== 200 || !is_array($data)) {
            return ['approved' => false, 'error_message' => 'Falha de comunicação com a Iugu (HTTP ' . $status . ').'];
        }
        $approved = ($data['success'] ?? false) === true && ($data['status'] ?? '') === 'captured';
        if (!$approved) {
            $msg = (string) ($data['info_message'] ?? (is_string($data['errors'] ?? null) ? $data['errors'] : (string) ($data['message'] ?? 'Cobrança não aprovada.')));
            return ['approved' => false, 'error_message' => $msg];
        }
        $providerReference = (string) ($data['invoice_id'] ?? $token);
        try {
            $this->call('UpdateInvoice', ['invoiceid' => $invoiceId, 'paymentmethod' => 'iugucartao']);
        } catch (WhmcsApiError) {
            // Não impede a baixa do pagamento -- só deixa o campo "forma de pagamento" do WHMCS desatualizado.
        }
        $this->call('AddInvoicePayment', [
            'invoiceid' => $invoiceId,
            'transid' => $providerReference,
            'gateway' => 'iugucartao',
            'amount' => round($totalCents / 100, 2),
            'noemail' => true,
        ]);
        return ['approved' => true, 'error_message' => null];
    }

    public function domainAvailable(string $domain): ?bool
    {
        try {
            $r = $this->call('DomainWhois', ['domain' => $domain]);
        } catch (WhmcsApiError) {
            return null;
        }
        return match ($r['status'] ?? '') {
            'available' => true,
            'unavailable' => false,
            default => null,
        };
    }

    public function domainPriceCents(string $domain): ?int
    {
        $best = null;
        foreach (Capsule::table('tbldomainpricing')->where('autoreg', '!=', '')->get(['id', 'extension']) as $t) {
            if (str_ends_with($domain, (string) $t->extension) && strlen($domain) > strlen((string) $t->extension) + 1 && ($best === null || strlen((string) $t->extension) > strlen((string) $best->extension))) {
                $best = $t;
            }
        }
        if ($best === null) {
            return null;
        }
        $currency = (int) (Capsule::table('tblcurrencies')->where('default', 1)->value('id') ?: 1);
        $price = Capsule::table('tblpricing')->where('type', 'domainregister')->where('relid', $best->id)->where('currency', $currency)->value('msetupfee');
        return $price !== null && (float) $price > 0 ? (int) round(((float) $price) * 100) : null;
    }

    public function updateClientAddress(int $clientId, array $address): void
    {
        $this->call('UpdateClient', ['clientid' => $clientId, 'country' => 'BR'] + $address);
    }

    public function addDomainOrder(int $clientId, string $domain, string $paymentMethod): array
    {
        $ns = static fn (string $k): string => (string) Capsule::table('tblconfiguration')->where('setting', $k)->value('value');
        $r = $this->call('AddOrder', [
            'clientid' => $clientId,
            'paymentmethod' => $paymentMethod,
            'domain' => [$domain],
            'domaintype' => ['register'],
            'regperiod' => [1],
            'nameserver1' => $ns('DefaultNameserver1'), // the WHMCS defaults are Way Cloud's own: the site is configured on them by itself
            'nameserver2' => $ns('DefaultNameserver2'),
            'noemail' => true,
            'noinvoiceemail' => true,
        ]);
        return ['orderid' => (int) $r['orderid'], 'invoiceid' => (int) ($r['invoiceid'] ?? 0)];
    }

    public function domainOrderInfo(int $orderId): ?array
    {
        $o = Capsule::table('tblorders')->where('id', $orderId)->first(['userid', 'invoiceid']);
        $d = Capsule::table('tbldomains')->where('orderid', $orderId)->first(['id', 'domain', 'status']);
        if ($o === null || $d === null) {
            return null;
        }
        return [
            'client_id' => (int) $o->userid,
            'invoice_id' => (int) $o->invoiceid,
            'invoice_status' => (string) Capsule::table('tblinvoices')->where('id', $o->invoiceid)->value('status'),
            'domain' => (string) $d->domain,
            'domain_status' => (string) $d->status,
            'domain_id' => (int) $d->id,
        ];
    }

    public function cancelOrder(int $orderId, int $invoiceId): void
    {
        $this->call('CancelOrder', ['orderid' => $orderId, 'noemail' => true]);
        $this->call('UpdateInvoice', ['invoiceid' => $invoiceId, 'status' => 'Cancelled']);
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
