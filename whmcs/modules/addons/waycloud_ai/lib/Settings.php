<?php
declare(strict_types=1);

namespace WayCloud\Ai;

final class Settings
{
    private const DEFAULTS = [
        'default_payment' => 'efipix',
        'sites_domain' => 'sites.waypreview.com.br',
        'checkout_ttl_hours' => '48',
        'terms_url' => 'https://waycloud.com.br/termos-de-servicos/',
        'privacy_url' => 'https://waycloud.com.br/politica-de-privacidade/',
        'alert_email' => 'contato@waycloud.com.br',
        'public_url' => 'https://waypreview.com.br',
        // Quick sign-up has no address: these fill WHMCS's required fields; the customer completes them later.
        'default_address1' => 'Não informado',
        'default_city' => 'Não informado',
        'default_state' => 'SP',
        'default_postcode' => '00000-000',
    ];

    /** @param array<string,string> $values */
    public function __construct(private array $values = [])
    {
    }

    public function get(string $key): string
    {
        $v = trim((string) ($this->values[$key] ?? ''));
        return $v !== '' ? $v : (self::DEFAULTS[$key] ?? '');
    }

    public function mcpUrl(): string
    {
        return rtrim($this->get('mcp_url'), '/');
    }

    public function ttlSeconds(): int
    {
        return max(1, (int) $this->get('checkout_ttl_hours')) * 3600;
    }

    /** Reads the addon settings saved in WHMCS (tbladdonmodules). */
    public static function fromWhmcs(): self
    {
        $rows = \WHMCS\Database\Capsule::table('tbladdonmodules')->where('module', 'waycloud_ai')->pluck('value', 'setting');
        return new self(is_array($rows) ? $rows : $rows->all());
    }
}
