<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** A request the addon API refuses; $code is a stable machine-readable string. */
final class ApiException extends \RuntimeException
{
    public function __construct(public readonly string $errorCode, public readonly int $status = 422)
    {
        parent::__construct($errorCode);
    }
}
