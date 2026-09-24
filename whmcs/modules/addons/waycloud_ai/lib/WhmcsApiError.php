<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** An error answered by WHMCS. The message is for logs and admins only, never for the customer. */
final class WhmcsApiError extends \RuntimeException
{
}
