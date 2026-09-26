<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** What the addon needs from WHMCS. LocalWhmcsApi wraps localAPI(); tests use a fake. */
interface WhmcsApi
{
    public function systemUrl(): string;

    public function findClientIdByEmail(string $email): ?int;

    /** Client currently logged in to the client area, if any. */
    public function currentClientId(): ?int;

    /** @param array<string,string> $data @throws WhmcsApiError */
    public function addClient(array $data): int;

    /** @return array{orderid:int, invoiceid:int, serviceid:int} @throws WhmcsApiError */
    public function addOrder(int $clientId, int $pid, string $cycle, string $domain, string $paymentMethod): array;

    /** Points the WHMCS service at another domain (its Plesk module finds the subscription by it). @throws WhmcsApiError */
    public function updateServiceDomain(int $serviceId, string $domain): void;

    /** Sends the customer the "define your password" e-mail. @throws WhmcsApiError */
    public function sendPasswordReset(string $email): void;

    /**
     * The Pix charge of an unpaid invoice that uses the Efí Pix gateway, created on the spot (the gateway makes it when it shows the invoice).
     * @return array{copy_paste:string, qr_image:string, amount_cents:int, expires_at:string}|null null when the invoice has no Pix
     */
    public function pixCharge(int $invoiceId): ?array;

    /** true/false from the WHMCS domain lookup, null when it could not tell. */
    public function domainAvailable(string $domain): ?bool;

    /** One-year registration price in the default currency, null when no registrar sells this ending. */
    public function domainPriceCents(string $domain): ?int;

    /** @param array<string,string> $address address1, address2, city, state, postcode @throws WhmcsApiError */
    public function updateClientAddress(int $clientId, array $address): void;

    /** An order that registers one domain for one year. @return array{orderid:int, invoiceid:int} @throws WhmcsApiError */
    public function addDomainOrder(int $clientId, string $domain, string $paymentMethod): array;

    /** @return array{client_id:int, invoice_id:int, invoice_status:string, domain:?string, domain_status:string, domain_id:int}|null */
    public function domainOrderInfo(int $orderId): ?array;

    /** Cancels the order and its (unpaid) invoice. @throws WhmcsApiError */
    public function cancelOrder(int $orderId, int $invoiceId): void;

    /** Logged-in URL for the client, landing on $path (e.g. "viewinvoice.php?id=10"). */
    public function createSsoUrl(int $clientId, string $path): ?string;

    /** @return array<string,int> client custom field name => id */
    public function clientCustomFieldIds(): array;

    /** @return list<string> names of client custom fields WHMCS marks as required */
    public function requiredClientFieldNames(): array;

    /** @return array{pid:int, name:string, monthly_cents:int, annual_cents:int}|null */
    public function productInfo(int $pid): ?array;

    /** @return list<string> active payment gateway module names */
    public function paymentModules(): array;

    public function adminAlert(string $subject, string $message): void;
}
