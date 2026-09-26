<?php
declare(strict_types=1);

/**
 * Way Cloud AI Deploy: addon module.
 * Sells and provisions hosting for sites published from AI assistants (MCP): quick checkout page,
 * signed API for the MCP service, and hooks that report payment and provisioning back to it.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/autoload.php';

function waycloud_ai_config(): array
{
    return [
        'name' => 'Way Cloud AI Deploy',
        'description' => 'Contratação rápida de hospedagem para sites publicados por assistentes de IA (MCP).',
        'version' => '0.5.0',
        'author' => 'Way Cloud',
        'language' => 'portuguese-br',
        'fields' => [
            'mcp_url' => ['FriendlyName' => 'URL do serviço MCP', 'Type' => 'text', 'Size' => '60', 'Default' => 'https://mcp.waycloud.com.br', 'Description' => 'Sem barra no final.'],
            'hmac_secret' => ['FriendlyName' => 'Segredo HMAC', 'Type' => 'text', 'Size' => '70', 'Description' => 'Mínimo de 32 caracteres. Deve ser igual ao ADDON_HMAC_SECRET do serviço MCP.'],
            'default_payment' => ['FriendlyName' => 'Forma de pagamento padrão', 'Type' => 'text', 'Size' => '20', 'Default' => 'efipix', 'Description' => 'Módulo do gateway (Pix). O cliente pode trocar por cartão na fatura.'],
            'sites_domain' => ['FriendlyName' => 'Domínio provisório dos sites', 'Type' => 'text', 'Size' => '40', 'Default' => 'sites.waypreview.com.br', 'Description' => 'Cada compra recebe um subdomínio deste domínio até o cliente apontar o dele.'],
            'checkout_ttl_hours' => ['FriendlyName' => 'Validade do link (horas)', 'Type' => 'text', 'Size' => '5', 'Default' => '48'],
            'terms_url' => ['FriendlyName' => 'URL dos Termos de Serviço', 'Type' => 'text', 'Size' => '60', 'Default' => 'https://waycloud.com.br/termos-de-servicos/'],
            'privacy_url' => ['FriendlyName' => 'URL da Política de Privacidade', 'Type' => 'text', 'Size' => '60', 'Default' => 'https://waycloud.com.br/politica-de-privacidade/'],
            'public_url' => ['FriendlyName' => 'Endereço público do site', 'Type' => 'text', 'Size' => '40', 'Default' => 'https://waypreview.com.br', 'Description' => 'Onde o cliente volta depois de pagar a fatura (sem barra no final).'],
            'alert_email' => ['FriendlyName' => 'E-mail de alertas', 'Type' => 'text', 'Size' => '40', 'Default' => 'contato@waycloud.com.br', 'Description' => 'Recebe avisos de falha de cadastro, pedido ou provisionamento.'],
            'default_address1' => ['FriendlyName' => 'Endereço padrão', 'Type' => 'text', 'Size' => '40', 'Default' => 'Não informado', 'Description' => 'O cadastro rápido não pede endereço; estes valores preenchem os campos obrigatórios do WHMCS.'],
            'default_city' => ['FriendlyName' => 'Cidade padrão', 'Type' => 'text', 'Size' => '30', 'Default' => 'Não informado'],
            'default_state' => ['FriendlyName' => 'Estado padrão', 'Type' => 'text', 'Size' => '10', 'Default' => 'SP'],
            'default_postcode' => ['FriendlyName' => 'CEP padrão', 'Type' => 'text', 'Size' => '12', 'Default' => '00000-000'],
        ],
    ];
}

function waycloud_ai_activate(): array
{
    try {
        \WayCloud\Ai\Schema::install();
        return ['status' => 'success', 'description' => 'Tabelas criadas. Configure o segredo HMAC e o mapa de planos.'];
    } catch (\Throwable $e) {
        return ['status' => 'error', 'description' => 'Não foi possível criar as tabelas: ' . $e->getMessage()];
    }
}

function waycloud_ai_deactivate(): array
{
    // Data is kept on purpose: it links orders to AI sessions.
    return ['status' => 'success', 'description' => 'Addon desativado. Os dados foram mantidos.'];
}

function waycloud_ai_upgrade(array $vars): void
{
    \WayCloud\Ai\Schema::install();
}

function waycloud_ai_output(array $vars): void
{
    echo \WayCloud\Ai\Admin::render((string) ($vars['modulelink'] ?? ''));
}

function waycloud_ai_clientarea(array $vars): array
{
    return \WayCloud\Ai\Page::handle($vars);
}
