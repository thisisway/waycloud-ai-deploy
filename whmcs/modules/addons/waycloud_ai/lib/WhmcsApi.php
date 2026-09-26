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
