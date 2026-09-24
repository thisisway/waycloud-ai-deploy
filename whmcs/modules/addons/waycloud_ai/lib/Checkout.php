<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * The whole checkout flow, independent of WHMCS internals (those live behind Store and WhmcsApi).
 * The AI never sees anything from here except the link: personal and payment data stay in the browser.
 */
final class Checkout
{
    public const CYCLES = ['monthly', 'annually'];
    private const CYCLE_LABEL = ['monthly' => 'mensal', 'annually' => 'anual'];
    private const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

    /**
     * @param \Closure(): int $now
     * @param \Closure(int): string $randomBytes
     */
    public function __construct(
        private Store $store,
        private WhmcsApi $whmcs,
        private Settings $settings,
        private Notifier $notifier,
        private \Closure $now,
        private \Closure $randomBytes,
    ) {
    }

    // ---- MCP -> addon -------------------------------------------------------------------------

    /**
     * @param array<string,mixed> $req
     * @return array{checkout_id:int, checkout_url:string, expires_at:string}
     */
    public function createFromMcp(array $req): array
    {
        $sessionId = (string) ($req['session_id'] ?? '');
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $sessionId)) {
            throw new ApiException('invalid_session');
        }
        $pid = filter_var($req['pid'] ?? null, FILTER_VALIDATE_INT);
        if ($pid === false || !in_array($pid, array_values($this->store->planMap()), true)) {
            throw new ApiException('invalid_plan');
        }
        $cycle = (string) ($req['cycle'] ?? '');
        if (!in_array($cycle, self::CYCLES, true)) {
            throw new ApiException('invalid_cycle');
        }

        $slug = '';
        foreach (str_split(($this->randomBytes)(10)) as $c) {
            $slug .= self::SLUG_ALPHABET[ord($c) % 32];
        }
        $token = rtrim(strtr(base64_encode(($this->randomBytes)(32)), '+/', '-_'), '=');
        $now = ($this->now)();

        $this->store->cancelOpenCheckouts($sessionId); // only the newest link works
        $id = $this->store->createCheckout([
            'token_hash' => hash('sha256', $token),
            'session_id' => $sessionId,
            'pid' => $pid,
            'cycle' => $cycle,
            'domain' => $slug . '.' . $this->settings->get('sites_domain'),
            'status' => 'new',
            'expires_at' => $now + $this->settings->ttlSeconds(),
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        $this->store->logEvent('checkout.created', (string) $id, ['pid' => $pid, 'cycle' => $cycle], $now);

        return [
            'checkout_id' => $id,
            'checkout_url' => rtrim($this->whmcs->systemUrl(), '/') . '/index.php?m=waycloud_ai&t=' . $token,
            'expires_at' => gmdate('c', $now + $this->settings->ttlSeconds()),
        ];
    }

    // ---- customer in the browser ----------------------------------------------------------------

    /** @return array{state:string, plan_name:string, price_cents:int, cycle_label:string, logged_in:bool} */
    public function view(string $token): array
    {
        $row = $this->find($token);
        $state = $this->stateOf($row);
        $info = $row ? $this->whmcs->productInfo((int) $row['pid']) : null;
        $cycle = (string) ($row['cycle'] ?? 'monthly');
        return [
            'state' => $state,
            'plan_name' => (string) ($info['name'] ?? ''),
            'price_cents' => (int) ($cycle === 'annually' ? ($info['annual_cents'] ?? 0) : ($info['monthly_cents'] ?? 0)),
            'cycle_label' => self::CYCLE_LABEL[$cycle] ?? 'mensal',
            'logged_in' => $this->whmcs->currentClientId() !== null,
        ];
    }

    /**
     * @param array<string,mixed> $in raw form fields
     * @return array{ok:bool, state:string, errors:array<string,string>, redirect:?string, login_url:?string}
     */
    public function submit(string $token, array $in, ?int $loggedInClientId = null): array
    {
        $row = $this->find($token);
        $state = $this->stateOf($row);
        if ($state !== 'ready' || $row === null) {
            return $this->result(false, $state);
        }
        // Bots fill the hidden field; answer as if the link were gone.
        if (trim((string) ($in['website'] ?? '')) !== '') {
            return $this->result(false, 'invalid');
        }

        $errors = $this->validate($in, $loggedInClientId !== null);
        if ($errors) {
            return $this->result(false, 'ready', $errors);
        }

        $id = (int) $row['id'];
        $clientId = $row['client_id'] !== null ? (int) $row['client_id'] : null;

        if ($clientId === null) {
            if ($loggedInClientId !== null) {
                $clientId = $loggedInClientId;
            } else {
                $email = trim((string) $in['email']);
                if ($this->whmcs->findClientIdByEmail($email) !== null) {
                    return $this->emailExists();
                }
                $ids = $this->whmcs->clientCustomFieldIds();
                if (!isset($ids['Tipo de documento'], $ids['CPF/CNPJ'])) {
                    $this->alert('Checkout AI: campos personalizados de cliente não encontrados', 'Crie os campos "Tipo de documento" e "CPF/CNPJ".');
                    return $this->result(false, 'ready', ['_form' => 'Cadastro temporariamente indisponível. Tente novamente em alguns minutos.']);
                }
                try {
                    $clientId = $this->whmcs->addClient($this->clientPayload($in, $ids));
                } catch (WhmcsApiError $e) {
                    return $this->clientError($e);
                }
            }
            $this->store->updateCheckout($id, ['client_id' => $clientId, 'status' => 'client_created'], ['new']);
        }

        // Compare-and-set: two simultaneous submits cannot both create an order.
        if (!$this->store->updateCheckout($id, ['status' => 'ordering'], ['client_created'])) {
            return $this->result(false, 'used');
        }
        try {
            $order = $this->whmcs->addOrder($clientId, (int) $row['pid'], (string) $row['cycle'], (string) $row['domain'], $this->settings->get('default_payment'));
        } catch (WhmcsApiError $e) {
            $this->store->updateCheckout($id, ['status' => 'client_created'], ['ordering']);
            $this->alert('Checkout AI: falha ao criar o pedido', $e->getMessage());
            return $this->result(false, 'ready', ['_form' => 'Não foi possível criar seu pedido agora. Tente novamente em alguns minutos.']);
        }

        $this->store->updateCheckout($id, ['status' => 'ordered', 'order_id' => $order['orderid'], 'invoice_id' => $order['invoiceid'], 'service_id' => $order['serviceid']], ['ordering']);
        $this->store->logEvent('order.created', (string) $id, ['order_id' => $order['orderid'], 'invoice_id' => $order['invoiceid']], ($this->now)());
        $this->notifier->queue('order.created', $this->payload($row) + [
            'whmcs_order_id' => $order['orderid'],
            'whmcs_invoice_id' => $order['invoiceid'],
            'whmcs_service_id' => $order['serviceid'],
        ]);

        $invoicePath = 'viewinvoice.php?id=' . $order['invoiceid'];
        $redirect = $this->whmcs->createSsoUrl($clientId, $invoicePath) ?? rtrim($this->whmcs->systemUrl(), '/') . '/' . $invoicePath;
        return $this->result(true, 'used', [], $redirect);
    }

    // ---- WHMCS hooks ----------------------------------------------------------------------------

    public function onInvoicePaid(int $invoiceId): void
    {
        $row = $this->store->findCheckoutBy('invoice_id', $invoiceId);
        if ($row === null) {
            return; // not an AI checkout invoice
        }
        if ($this->store->updateCheckout((int) $row['id'], ['status' => 'paid'], ['ordered'])) {
            $this->notifier->queue('order.paid', $this->payload($row) + ['whmcs_invoice_id' => $invoiceId]);
        }
    }

    /** @param array{server_id?:int} $info */
    public function onModuleCreated(int $serviceId, array $info = []): void
    {
        $row = $this->store->findCheckoutBy('service_id', $serviceId);
        if ($row === null) {
            return;
        }
        $id = (int) $row['id'];
        // WHMCS can provision before our InvoicePaid hook runs: payment is implied.
        if ($this->store->updateCheckout($id, ['status' => 'paid'], ['ordered'])) {
            $this->notifier->queue('order.paid', $this->payload($row) + ['whmcs_invoice_id' => (int) $row['invoice_id']]);
        }
        if ($this->store->updateCheckout($id, ['status' => 'active'], ['paid'])) {
            $this->notifier->queue('service.active', $this->payload($row) + [
                'whmcs_service_id' => $serviceId,
                'domain' => (string) $row['domain'],
                'whmcs_server_id' => (int) ($info['server_id'] ?? 0),
            ]);
        }
    }

    public function onModuleCreateFailed(int $serviceId, string $reason): void
    {
        $row = $this->store->findCheckoutBy('service_id', $serviceId);
        if ($row === null) {
            return;
        }
        if ($this->store->updateCheckout((int) $row['id'], ['status' => 'failed'], ['ordered', 'paid'])) {
            $this->notifier->queue('service.failed', $this->payload($row) + ['whmcs_service_id' => $serviceId, 'reason_code' => 'provisioning_failed']);
        }
        // The raw reason is for the admin only; it never goes to the AI or the customer.
        $this->alert('Checkout AI: falha ao provisionar o serviço #' . $serviceId, $reason);
    }

    // ---- internals --------------------------------------------------------------------------------

    /** @return array<string,mixed>|null */
    private function find(string $token): ?array
    {
        if (!preg_match('/^[A-Za-z0-9_-]{20,100}$/', $token)) {
            return null;
        }
        return $this->store->findCheckoutByTokenHash(hash('sha256', $token));
    }

    /** @param array<string,mixed>|null $row */
    private function stateOf(?array $row): string
    {
        if ($row === null) {
            return 'invalid';
        }
        $status = (string) $row['status'];
        if ($status === 'cancelled') {
            return 'invalid';
        }
        if ($status === 'expired') {
            return 'expired';
        }
        if (in_array($status, ['ordering', 'ordered', 'paid', 'active', 'failed'], true)) {
            return 'used';
        }
        if ((int) $row['expires_at'] < ($this->now)()) {
            $this->store->updateCheckout((int) $row['id'], ['status' => 'expired'], ['new', 'client_created']);
            return 'expired';
        }
        return 'ready';
    }

    /** @param array<string,mixed> $row @return array<string,mixed> ids only */
    private function payload(array $row): array
    {
        return [
            'session_id' => (string) $row['session_id'],
            'checkout_id' => (int) $row['id'],
            'plan_pid' => (int) $row['pid'],
            'cycle' => (string) $row['cycle'],
        ];
    }

    /** @param array<string,mixed> $in @return array<string,string> */
    private function validate(array $in, bool $loggedIn): array
    {
        $e = [];
        if (empty($in['aceite'])) {
            $e['aceite'] = 'Você precisa aceitar os Termos de Serviço e a Política de Privacidade.';
        }
        if ($loggedIn) {
            return $e;
        }
        $nome = trim((string) ($in['nome'] ?? ''));
        if (mb_strlen($nome) < 3 || mb_strlen($nome) > 100 || !str_contains($nome, ' ')) {
            $e['nome'] = 'Informe seu nome e sobrenome.';
        }
        $email = trim((string) ($in['email'] ?? ''));
        if (strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            $e['email'] = 'Informe um e-mail válido.';
        }
        $type = (string) ($in['doc_tipo'] ?? '');
        if (!in_array($type, ['CPF', 'CNPJ'], true) || !Document::validate($type, (string) ($in['doc_numero'] ?? ''))) {
            $e['doc_numero'] = 'CPF ou CNPJ inválido.';
        }
        if (self::phone((string) ($in['telefone'] ?? '')) === null) {
            $e['telefone'] = 'Informe um telefone com DDD.';
        }
        $senha = (string) ($in['senha'] ?? '');
        if (strlen($senha) < 8 || strlen($senha) > 64) {
            $e['senha'] = 'A senha precisa ter de 8 a 64 caracteres.';
        }
        return $e;
    }

    /** WHMCS format: +55.11999998888 */
    public static function phone(string $raw): ?string
    {
        $d = preg_replace('/\D/', '', $raw) ?? '';
        if (strlen($d) >= 12 && str_starts_with($d, '55')) {
            $d = substr($d, 2);
        }
        return strlen($d) === 10 || strlen($d) === 11 ? '+55.' . $d : null;
    }

    /** (11) 99999-8888 */
    public static function phoneDisplay(string $raw): ?string
    {
        $p = self::phone($raw);
        if ($p === null) {
            return null;
        }
        $d = substr($p, 4); // after "+55."
        return strlen($d) === 11
            ? '(' . substr($d, 0, 2) . ') ' . substr($d, 2, 5) . '-' . substr($d, 7)
            : '(' . substr($d, 0, 2) . ') ' . substr($d, 2, 4) . '-' . substr($d, 6);
    }

    /** @param array<string,mixed> $in @param array<string,int> $ids @return array<string,string> */
    private function clientPayload(array $in, array $ids): array
    {
        $nome = preg_split('/\s+/', trim((string) $in['nome']), 2) ?: [];
        $type = (string) $in['doc_tipo'];
        return [
            'firstname' => (string) ($nome[0] ?? ''),
            'lastname' => (string) ($nome[1] ?? ''),
            'email' => trim((string) $in['email']),
            'address1' => $this->settings->get('default_address1'),
            'city' => $this->settings->get('default_city'),
            'state' => $this->settings->get('default_state'),
            'postcode' => $this->settings->get('default_postcode'),
            'country' => 'BR',
            'phonenumber' => (string) self::phone((string) $in['telefone']),
            'password2' => (string) $in['senha'],
            'notes' => 'Cadastro rápido via IA: endereço a completar pelo cliente.',
            'customfields' => base64_encode(serialize(array_filter([
                $ids['Tipo de documento'] => $type,
                $ids['CPF/CNPJ'] => Document::format($type, (string) $in['doc_numero']),
                // "Celular" is a required client field in this WHMCS: fill it with the same phone.
                ($ids['Celular'] ?? 0) => isset($ids['Celular']) ? self::phoneDisplay((string) $in['telefone']) : null,
            ], static fn ($v, $k): bool => $k !== 0 && $v !== null, ARRAY_FILTER_USE_BOTH))),
        ];
    }

    /** @return array{ok:bool, state:string, errors:array<string,string>, redirect:?string, login_url:?string} */
    private function emailExists(): array
    {
        $r = $this->result(false, 'ready', ['email' => 'Já existe uma conta com este e-mail. Entre na sua conta e abra este link novamente.']);
        $r['login_url'] = rtrim($this->whmcs->systemUrl(), '/') . '/clientarea.php';
        return $r;
    }

    /** @return array{ok:bool, state:string, errors:array<string,string>, redirect:?string, login_url:?string} */
    private function clientError(WhmcsApiError $e): array
    {
        $m = strtolower($e->getMessage());
        if (str_contains($m, 'password')) {
            return $this->result(false, 'ready', ['senha' => 'A senha é fraca. Use letras, números e símbolos.']);
        }
        if (str_contains($m, 'email') && (str_contains($m, 'exist') || str_contains($m, 'already'))) {
            return $this->emailExists();
        }
        $this->alert('Checkout AI: falha ao criar o cliente', $e->getMessage());
        return $this->result(false, 'ready', ['_form' => 'Não foi possível criar seu cadastro agora. Tente novamente em alguns minutos.']);
    }

    private function alert(string $subject, string $message): void
    {
        $this->store->logEvent('alert', null, ['subject' => $subject], ($this->now)());
        $this->whmcs->adminAlert($subject, $message);
    }

    /**
     * @param array<string,string> $errors
     * @return array{ok:bool, state:string, errors:array<string,string>, redirect:?string, login_url:?string}
     */
    private function result(bool $ok, string $state, array $errors = [], ?string $redirect = null): array
    {
        return ['ok' => $ok, 'state' => $state, 'errors' => $errors, 'redirect' => $redirect, 'login_url' => null];
    }
}
