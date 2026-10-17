namespace AigcHub.Api.Endpoints;

internal static class EndpointHelpers
{
    public static (int Page, int PageSize) NormalizePage(int page, int pageSize) =>
        (Math.Max(1, page), Math.Clamp(pageSize <= 0 ? 10 : pageSize, 1, 100));
}
