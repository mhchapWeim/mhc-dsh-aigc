namespace AigcHub.Api.Services;

/// <summary>Effective image input capability; missing metadata is not a negative capability.</summary>
public sealed record ModelImageCapability(string State, string Source, string Reason)
{
    // Keep the legacy input field conservative for clients that do not understand State.
    public string[] Input => State == "supported" ? ["text", "image"] : ["text"];

    public static ModelImageCapability Resolve(string mode, LiteLlmModelCapability? upstream = null) => mode switch
    {
        "Supported" => new("supported", "administrator", "管理员已配置支持图片理解"),
        "Unsupported" => new("unsupported", "administrator", "管理员已配置不支持图片理解"),
        _ => upstream?.SupportsVision switch
        {
            true => new("supported", "upstream", "上游声明支持图片理解"),
            false => new("unsupported", "upstream", "上游声明不支持图片理解"),
            _ => new("unknown", "undisclosed", "图片能力尚未确认，请管理员在模型管理中配置图片理解能力")
        }
    };
}
