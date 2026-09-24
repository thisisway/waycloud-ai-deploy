<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** CPF / CNPJ validation, including the alphanumeric CNPJ introduced in July 2026. */
final class Document
{
    public static function normalize(string $type, string $value): string
    {
        return $type === 'CNPJ'
            ? strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $value) ?? '')
            : (preg_replace('/\D/', '', $value) ?? '');
    }

    public static function validate(string $type, string $value): bool
    {
        return match ($type) {
            'CPF' => self::isCpf($value),
            'CNPJ' => self::isCnpj($value),
            default => false,
        };
    }

    public static function isCpf(string $value): bool
    {
        $d = self::normalize('CPF', $value);
        if (strlen($d) !== 11 || preg_match('/^(\d)\1{10}$/', $d)) {
            return false;
        }
        for ($t = 9; $t < 11; $t++) {
            $sum = 0;
            for ($i = 0; $i < $t; $i++) {
                $sum += (int) $d[$i] * ($t + 1 - $i);
            }
            if (((($sum * 10) % 11) % 10) !== (int) $d[$t]) {
                return false;
            }
        }
        return true;
    }

    /** 12 base characters ([0-9A-Z]) followed by 2 numeric check digits. Value of a char = ord(c) - 48. */
    public static function isCnpj(string $value): bool
    {
        $c = self::normalize('CNPJ', $value);
        if (!preg_match('/^[0-9A-Z]{12}[0-9]{2}$/', $c) || preg_match('/^(.)\1{13}$/', $c)) {
            return false;
        }
        $check = static function (string $base, array $weights): int {
            $sum = 0;
            foreach ($weights as $i => $w) {
                $sum += (ord($base[$i]) - 48) * $w;
            }
            $r = $sum % 11;
            return $r < 2 ? 0 : 11 - $r;
        };
        $d1 = $check(substr($c, 0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        $d2 = $check(substr($c, 0, 12) . $d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        return $d1 === (int) $c[12] && $d2 === (int) $c[13];
    }

    public static function format(string $type, string $value): string
    {
        $d = self::normalize($type, $value);
        if ($type === 'CPF' && strlen($d) === 11) {
            return substr($d, 0, 3) . '.' . substr($d, 3, 3) . '.' . substr($d, 6, 3) . '-' . substr($d, 9);
        }
        if ($type === 'CNPJ' && strlen($d) === 14) {
            return substr($d, 0, 2) . '.' . substr($d, 2, 3) . '.' . substr($d, 5, 3) . '/' . substr($d, 8, 4) . '-' . substr($d, 12);
        }
        return $d;
    }
}
