<?php
declare(strict_types=1);

namespace WayCloud\Ai;

final class Http
{
    /** @param list<string> $headers @return int HTTP status, 0 on network error */
    public static function post(string $url, array $headers, string $body): int
    {
        return self::request($url, ['POST' => true, 'BODY' => $body, 'HEADERS' => $headers]);
    }

    /** @return int HTTP status, 0 on network error */
    public static function get(string $url): int
    {
        return self::request($url, []);
    }

    /** @param array{POST?:bool, BODY?:string, HEADERS?:list<string>} $o */
    private static function request(string $url, array $o): int
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return 0;
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_USERAGENT => 'WayCloud-AI-Addon/1.0',
        ]);
        if (!empty($o['POST'])) {
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, $o['BODY'] ?? '');
            curl_setopt($ch, CURLOPT_HTTPHEADER, $o['HEADERS'] ?? []);
        }
        curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $status;
    }
}
