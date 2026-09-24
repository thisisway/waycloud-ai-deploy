<?php
declare(strict_types=1);

namespace WayCloud\Ai;

interface Notifier
{
    /** Queues an event for the MCP service. Payloads carry ids only, never personal data. @param array<string,mixed> $payload */
    public function queue(string $event, array $payload): void;
}
