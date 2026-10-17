using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;

namespace AigcHub.Api.Services;

public sealed record PluginPackageMetadata(string PackageName, string Version, string Description, string DshVersion, string ManifestJson);

public static partial class PluginPackageReader
{
    public const long MaximumBytes = 32 * 1024 * 1024;

    public static PluginPackageMetadata Read(Stream stream)
    {
        using var gzip = new GZipStream(stream, CompressionMode.Decompress, leaveOpen: true);
        using var tar = new TarReader(gzip);
        var paths = new HashSet<string>(StringComparer.Ordinal);
        string? manifest = null;
        long total = 0;
        var count = 0;
        TarEntry? entry;
        while ((entry = tar.GetNextEntry()) is not null)
        {
            if (++count > 5000 || (total += entry.Length) > MaximumBytes * 4)
                throw new WorkflowException("插件解压体积或文件数量超出限制", 400);
            var path = entry.Name;
            if (!path.StartsWith("package/", StringComparison.Ordinal) || path.Contains('\\')
                || path.Split('/').Any(part => part is ".." or ".") || !paths.Add(path)
                || entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile or TarEntryType.Directory))
                throw new WorkflowException("插件包包含无效路径、链接或重复文件", 400);
            if (path == "package/package.json")
            {
                if (entry.Length > 128 * 1024 || entry.DataStream is null) throw new WorkflowException("插件清单过大", 400);
                using var reader = new StreamReader(entry.DataStream, Encoding.UTF8, true, 1024, leaveOpen: true);
                manifest = reader.ReadToEnd();
            }
        }
        if (manifest is null) throw new WorkflowException("缺少 package/package.json", 400);
        using var document = JsonDocument.Parse(manifest);
        var root = document.RootElement;
        var name = root.GetProperty("name").GetString() ?? "";
        var version = root.GetProperty("version").GetString() ?? "";
        if (!PackageName().IsMatch(name) || !PackageVersion().IsMatch(version))
            throw new WorkflowException("插件包名或版本号无效", 400);
        if (name.StartsWith("@deepseek-ai/", StringComparison.Ordinal))
            throw new WorkflowException("插件市场不能替换 DSH 核心包", 400);
        if (root.TryGetProperty("scripts", out var scripts) && scripts.EnumerateObject().Any(x =>
            x.Name is "preinstall" or "install" or "postinstall" or "prepare"))
            throw new WorkflowException("发布包不能包含安装生命周期脚本，请先构建再打包", 400);
        if (root.TryGetProperty("dependencies", out var dependencies) && dependencies.EnumerateObject().Any(x =>
            x.Value.ValueKind != JsonValueKind.String || x.Value.GetString()!.StartsWith("workspace:")
            || x.Value.GetString()!.StartsWith("file:") || x.Value.GetString()!.StartsWith("link:")))
            throw new WorkflowException("发布包包含本地或 workspace 运行依赖", 400);
        var patch = root.GetProperty("dsh").GetProperty("bundle").GetProperty("patch");
        var patches = patch.ValueKind == JsonValueKind.String ? new[] { patch.GetString()! }
            : patch.EnumerateArray().Select(x => x.GetString()!).ToArray();
        if (patches.Length == 0 || patches.Any(path => !paths.Contains("package/" + PackageFile(path))))
            throw new WorkflowException("组合包 patch 文件不存在", 400);
        var aigc = root.GetProperty("aigc");
        var dshVersion = aigc.GetProperty("dshVersion").GetString() ?? "";
        // Exact versions deliberately avoid silently accepting incompatible pre-stable DSH APIs.
        if (!PackageVersion().IsMatch(dshVersion)) throw new WorkflowException("aigc.dshVersion 必须声明准确的 DSH 版本", 400);
        var main = root.GetProperty("main").GetString() ?? "";
        if (!paths.Contains("package/" + PackageFile(main))) throw new WorkflowException("插件运行入口不存在", 400);
        return new(name, version, root.TryGetProperty("description", out var description) ? description.GetString() ?? "" : "", dshVersion, manifest);
    }

    private static string PackageFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.StartsWith('/') || path.Contains('\\') || path.Contains(':') || path.Split('/').Contains(".."))
            throw new WorkflowException("插件入口或 patch 路径无效", 400);
        return path.StartsWith("./", StringComparison.Ordinal) ? path[2..] : path;
    }

    [GeneratedRegex("^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")]
    private static partial Regex PackageName();
    [GeneratedRegex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")]
    private static partial Regex PackageVersion();
}
