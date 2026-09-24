<?php
// Minimal PSR-4 style autoloader for WayCloud\Ai\* -> lib/*.php

spl_autoload_register(static function (string $class): void {
    $prefix = 'WayCloud\\Ai\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
