using System.Text.RegularExpressions;

namespace AigcHub.Api.Services;

/// <summary>SemVer comparison for assigning Windows desktop releases.</summary>
public static partial class DesktopVersion
{
    [GeneratedRegex(@"^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")]
    private static partial Regex Pattern();

    public static bool Valid(string? value)
    {
        if (value is null || value.Length > 100) return false;
        var match = Pattern().Match(value);
        if (!match.Success) return false;
        var prerelease = match.Groups[4].Value;
        return prerelease.Length == 0 || prerelease.Split('.').All(x =>
            !x.All(char.IsAsciiDigit) || x.Length == 1 || x[0] != '0');
    }

    public static int Compare(string left, string right)
    {
        var a = Pattern().Match(left); var b = Pattern().Match(right);
        for (var i = 1; i <= 3; i++)
        {
            var comparison = int.Parse(a.Groups[i].Value).CompareTo(int.Parse(b.Groups[i].Value));
            if (comparison != 0) return comparison;
        }
        var x = a.Groups[4].Value; var y = b.Groups[4].Value;
        if (x == y) return 0;
        if (x.Length == 0) return 1;
        if (y.Length == 0) return -1;
        var xs = x.Split('.'); var ys = y.Split('.');
        for (var i = 0; i < Math.Min(xs.Length, ys.Length); i++)
        {
            var xn = xs[i].All(char.IsAsciiDigit); var yn = ys[i].All(char.IsAsciiDigit);
            var comparison = xn && yn ? (xs[i].Length.CompareTo(ys[i].Length) is var length && length != 0
                ? length : string.CompareOrdinal(xs[i], ys[i])) : xn != yn ? (xn ? -1 : 1) : string.CompareOrdinal(xs[i], ys[i]);
            if (comparison != 0) return comparison;
        }
        return xs.Length.CompareTo(ys.Length);
    }
}
