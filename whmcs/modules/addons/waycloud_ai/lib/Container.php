<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** Builds the real (WHMCS-backed) object graph. Hooks, api.php and the client area go through here. */
final class Container
{
    public static function settings(): Settings
    {
        return Settings::fromWhmcs();
    }

    public static function store(): Store
    {
        return new CapsuleStore();
    }

    public static function whmcs(): WhmcsApi
    {
        return new LocalWhmcsApi(self::settings());
    }

    public static function notifier(): McpNotifier
    {
        return new McpNotifier(self::store(), self::settings(), Http::post(...), static fn (): int => time());
    }

    public static function checkout(): Checkout
    {
        return new Checkout(
            self::store(),
            self::whmcs(),
            self::settings(),
            self::notifier(),
            static fn (): int => time(),
            static fn (int $n): string => random_bytes($n),
        );
    }

    public static function api(): Api
    {
        return new Api(self::store(), self::settings(), self::checkout(), self::whmcs(), static fn (): int => time());
    }
}
