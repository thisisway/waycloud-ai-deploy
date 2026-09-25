<?php
declare(strict_types=1);

/**
 * WHMCS hooks. They must never break WHMCS itself, so every handler swallows and logs its errors.
 * verify: the AfterModuleCreate / AfterModuleCreateFailed variable names below follow the WHMCS
 * docs and are checked by the first real provisioning in the test product.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/autoload.php';

use WayCloud\Ai\Container;

$waycloudGuard = static function (string $where, callable $fn): void {
    try {
        $fn();
    } catch (\Throwable $e) {
        logActivity('Way Cloud AI (' . $where . '): ' . $e->getMessage());
    }
};

add_hook('InvoicePaid', 1, static function (array $vars) use ($waycloudGuard): void {
    $waycloudGuard('InvoicePaid', static fn () => Container::checkout()->onInvoicePaid((int) ($vars['invoiceid'] ?? 0)));
});

add_hook('AfterModuleCreate', 1, static function (array $vars) use ($waycloudGuard): void {
    $p = (array) ($vars['params'] ?? []);
    $waycloudGuard('AfterModuleCreate', static fn () => Container::checkout()->onModuleCreated((int) ($p['serviceid'] ?? 0), ['server_id' => (int) ($p['serverid'] ?? 0)]));
});

add_hook('AfterModuleCreateFailed', 1, static function (array $vars) use ($waycloudGuard): void {
    $p = (array) ($vars['params'] ?? []);
    $waycloudGuard('AfterModuleCreateFailed', static fn () => Container::checkout()->onModuleCreateFailed((int) ($p['serviceid'] ?? 0), (string) ($vars['failureResponseMessage'] ?? 'unknown')));
});

// The invoice page of an AI checkout gets a way back to the public site (which keeps following the order).
add_hook('ClientAreaFooterOutput', 1, static function (array $vars) use ($waycloudGuard): string {
    $html = '';
    $waycloudGuard('ClientAreaFooterOutput', static function () use ($vars, &$html): void {
        $html = Container::checkout()->invoiceBanner($vars);
    });
    return $html;
});

// WHMCS runs its cron every few minutes: retry webhooks that could not be delivered.
add_hook('AfterCronJob', 1, static function () use ($waycloudGuard): void {
    $waycloudGuard('AfterCronJob', static fn () => Container::notifier()->flush(50));
});
