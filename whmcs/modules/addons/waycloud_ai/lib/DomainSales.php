<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * Selling a domain to the customer of an AI checkout: search, order (an ordinary WHMCS domain-registration order that the
 * customer pays with the Pix on the public page), follow it and cancel it. The registrar module registers the domain on
 * payment; the public service then points it at the site. Only the session that made the checkout can touch its orders.
 */
final class DomainSales
{
    private const DOMAIN = '/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/';
    private const STATES = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

    /** @param \Closure(): int $now */
    public function __construct(private Store $store, private WhmcsApi $whmcs, private Settings $settings, private \Closure $now)
    {
    }

    /**
     * @param array<string,mixed> $req domains: up to 6 names to check
     * @return array{results: list<array{domain:string, available:?bool, price_cents:int}>} only what can be sold here (a price and a registrar)
     */
    public function search(array $req): array
    {
        $names = is_array($req['domains'] ?? null) ? array_slice(array_values($req['domains']), 0, 6) : [];
        $out = [];
        foreach ($names as $name) {
            $domain = strtolower(trim((string) $name));
            if (strlen($domain) > 253 || !preg_match(self::DOMAIN, $domain)) {
                continue;
            }
            $price = $this->whmcs->domainPriceCents($domain);
            if ($price === null) {
                continue;
            }
            $out[] = ['domain' => $domain, 'available' => $this->whmcs->domainAvailable($domain), 'price_cents' => $price];
        }
        return ['results' => $out];
    }

    /**
     * @param array<string,mixed> $req checkout_id, session_id, domain, address{cep,logradouro,numero,complemento,bairro,cidade,uf}
     * @return array{ok:bool, errors:array<string,string>, order_id:?int, invoice_id:?int, redirect:?string, price_cents:?int}
     */
    public function order(array $req): array
    {
        $row = $this->ownedCheckout($req);
        $clientId = (int) ($row['client_id'] ?? 0);
        if ($clientId <= 0) {
            throw new ApiException('no_client', 409);
        }
        $domain = strtolower(trim((string) ($req['domain'] ?? '')));
        if (strlen($domain) > 253 || !preg_match(self::DOMAIN, $domain)) {
            return $this->refused(['dominio' => 'Informe um domínio válido.']);
        }
        $price = $this->whmcs->domainPriceCents($domain);
        if ($price === null) {
            return $this->refused(['dominio' => 'Não registramos domínios com essa terminação.']);
        }
        [$address, $errors] = $this->address(is_array($req['address'] ?? null) ? $req['address'] : []);
        if ($errors) {
            return $this->refused($errors);
        }
        if ($this->whmcs->domainAvailable($domain) !== true) {
            return $this->refused(['dominio' => 'Este domínio não está mais disponível. Escolha outro.']);
        }
        try {
            $this->whmcs->updateClientAddress($clientId, $address);
            $order = $this->whmcs->addDomainOrder($clientId, $domain, $this->settings->get('default_payment'));
        } catch (WhmcsApiError $e) {
            $this->store->logEvent('alert', null, ['subject' => 'domain order failed'], ($this->now)());
            $this->whmcs->adminAlert('Checkout AI: falha ao pedir o domínio ' . $domain, $e->getMessage());
            return $this->refused(['_form' => 'Não foi possível criar o pedido do domínio agora. Tente novamente em instantes.']);
        }
        $this->store->logEvent('domain.ordered', (string) $row['id'], ['order_id' => $order['orderid'], 'invoice_id' => $order['invoiceid']], ($this->now)());
        $invoicePath = 'viewinvoice.php?id=' . $order['invoiceid'];
        $redirect = $this->whmcs->createSsoUrl($clientId, $invoicePath) ?? rtrim($this->whmcs->systemUrl(), '/') . '/' . $invoicePath;
        return ['ok' => true, 'errors' => [], 'order_id' => $order['orderid'], 'invoice_id' => $order['invoiceid'], 'redirect' => $redirect, 'price_cents' => $price];
    }

    /**
     * @param array<string,mixed> $req checkout_id, session_id, order_id
     * @return array{status:string, domain:?string}
     *   status: awaiting_payment | registering | registered | failed | canceled
     */
    public function status(array $req): array
    {
        $info = $this->ownedOrder($req);
        $status = match (true) {
            $info['invoice_status'] === 'Cancelled' || $info['domain_status'] === 'Cancelled' => 'canceled',
            $info['invoice_status'] !== 'Paid' => 'awaiting_payment',
            $info['domain_status'] === 'Active' => 'registered',
            $this->store->hasEvent('domain.registration_failed', (string) $info['domain_id']) => 'failed',
            default => 'registering',
        };
        return ['status' => $status, 'domain' => $info['domain']];
    }

    /**
     * The Pix of the domain invoice.
     * @param array<string,mixed> $req checkout_id, session_id, order_id
     * @return array<string,mixed> {ok:false} when there is nothing to pay with Pix
     */
    public function pix(array $req): array
    {
        $info = $this->ownedOrder($req);
        $pix = $this->whmcs->pixCharge($info['invoice_id']);
        return $pix === null ? ['ok' => false] : ['ok' => true] + $pix;
    }

    /**
     * The customer gave up before paying: the order and its invoice are cancelled (a paid one is left alone).
     * @param array<string,mixed> $req checkout_id, session_id, order_id
     * @return array{ok:bool}
     */
    public function cancel(array $req): array
    {
        $info = $this->ownedOrder($req);
        if ($info['invoice_status'] === 'Unpaid') {
            $this->whmcs->cancelOrder((int) $req['order_id'], $info['invoice_id']);
            $this->store->logEvent('domain.order_cancelled', (string) ($req['checkout_id'] ?? ''), ['order_id' => (int) $req['order_id']], ($this->now)());
            return ['ok' => true];
        }
        return ['ok' => false];
    }

    /** WHMCS could not register a paid domain: the team must finish it by hand, the customer is told we are on it. */
    public function onRegistrationFailed(int $domainId, string $message): void
    {
        $this->store->logEvent('domain.registration_failed', (string) $domainId, [], ($this->now)());
        $this->whmcs->adminAlert('Checkout AI: o registro do domínio #' . $domainId . ' falhou', $message);
    }

    /** @param array<string,mixed> $req @return array<string,mixed> */
    private function ownedCheckout(array $req): array
    {
        $id = filter_var($req['checkout_id'] ?? null, FILTER_VALIDATE_INT);
        $row = $id === false || $id <= 0 ? null : $this->store->findCheckoutBy('id', $id);
        if ($row === null || !hash_equals((string) $row['session_id'], (string) ($req['session_id'] ?? ''))) {
            throw new ApiException('unknown_checkout', 404);
        }
        return $row;
    }

    /**
     * @param array<string,mixed> $req
     * @return array{client_id:int, invoice_id:int, invoice_status:string, domain:?string, domain_status:string, domain_id:int}
     */
    private function ownedOrder(array $req): array
    {
        $row = $this->ownedCheckout($req);
        $orderId = filter_var($req['order_id'] ?? null, FILTER_VALIDATE_INT);
        $info = $orderId === false || $orderId <= 0 ? null : $this->whmcs->domainOrderInfo($orderId);
        if ($info === null || $info['client_id'] !== (int) ($row['client_id'] ?? 0)) {
            throw new ApiException('unknown_order', 404);
        }
        return $info;
    }

    /**
     * Registrars need a real postal address (the placeholder one from the quick sign-up will not do).
     * @param array<string,mixed> $in
     * @return array{0: array<string,string>, 1: array<string,string>} [clean address, errors by field]
     */
    private function address(array $in): array
    {
        $errors = [];
        $text = static fn (string $k): string => trim(preg_replace('/\s+/', ' ', (string) ($in[$k] ?? '')) ?? '');
        $cep = preg_replace('/\D/', '', (string) ($in['cep'] ?? '')) ?? '';
        $logradouro = $text('logradouro');
        $numero = $text('numero');
        $complemento = $text('complemento');
        $bairro = $text('bairro');
        $cidade = $text('cidade');
        $uf = strtoupper($text('uf'));
        if (strlen($cep) !== 8) {
            $errors['cep'] = 'Informe o CEP com 8 números.';
        }
        if (mb_strlen($logradouro) < 3 || mb_strlen($logradouro) > 80) {
            $errors['logradouro'] = 'Informe a rua ou avenida.';
        }
        if ($numero === '' || mb_strlen($numero) > 10) {
            $errors['numero'] = 'Informe o número (ou S/N).';
        }
        if (mb_strlen($complemento) > 40) {
            $errors['complemento'] = 'Complemento muito longo.';
        }
        if (mb_strlen($bairro) < 2 || mb_strlen($bairro) > 60) {
            $errors['bairro'] = 'Informe o bairro.';
        }
        if (mb_strlen($cidade) < 2 || mb_strlen($cidade) > 60) {
            $errors['cidade'] = 'Informe a cidade.';
        }
        if (!in_array($uf, self::STATES, true)) {
            $errors['uf'] = 'Escolha o estado.';
        }
        return [[
            'address1' => $logradouro . ', ' . $numero,
            'address2' => $complemento !== '' ? $bairro . ' - ' . $complemento : $bairro,
            'city' => $cidade,
            'state' => $uf,
            'postcode' => substr($cep, 0, 5) . '-' . substr($cep, 5),
        ], $errors];
    }

    /** @param array<string,string> $errors @return array{ok:bool, errors:array<string,string>, order_id:?int, invoice_id:?int, redirect:?string, price_cents:?int} */
    private function refused(array $errors): array
    {
        return ['ok' => false, 'errors' => $errors, 'order_id' => null, 'invoice_id' => null, 'redirect' => null, 'price_cents' => null];
    }
}
