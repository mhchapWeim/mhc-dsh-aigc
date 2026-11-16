using System.Text.Json.Nodes;

namespace AigcHub.Api.Services;

public static class IntegrationDefinitionValidator
{
    public static string? Validate(JsonNode doc)
    {
        if (doc["executionMode"]?.ToString() != "integrated-v1")
            return doc["nodes"]?.AsArray().Any(n => !string.IsNullOrWhiteSpace(IntegrationWorkflowRunner.Text(n, "serviceCode"))) == true
                ? "已配置第三方服务的流程必须启用第三方流程执行" : null;
        var nodes = doc["nodes"]!.AsArray(); var edges = doc["edges"]?.AsArray();
        if (edges is null) return "第三方流程必须配置连线";
        foreach (var node in nodes)
        {
            var id = IntegrationWorkflowRunner.Text(node, "id");
            var type = IntegrationWorkflowRunner.Text(node, "type");
            var outgoing = edges.Where(e => IntegrationWorkflowRunner.Text(e, "source") == id).ToArray();
            var outcomes = outgoing.Select(e => IntegrationWorkflowRunner.Text(e, "outcome")).ToArray();
            if (outcomes.Distinct().Count() != outcomes.Length) return $"节点 {id} 存在重复出口条件";
            if (outcomes.Any(x => x is not ("" or "passed" or "rejected" or "succeeded" or "failed" or "timeout" or "needs-review" or "cancelled" or "request-rejected"))) return "连线结果条件无效";
            if (type == "start" && (outgoing.Length != 1 || outcomes[0] != "")) return "开始节点必须有唯一默认出口";
            if (type == "end" && IntegrationWorkflowRunner.Text(node, "result") is not ("Approved" or "Rejected" or "Failed")) return "结束节点必须指定通过、退回或失败";
            if (type is "userTask" or "serviceTask")
            {
                var required = type == "userTask" ? new[] { "passed", "rejected" } : new[] { "passed", "rejected", "succeeded", "failed", "timeout" };
                if (!outcomes.Contains("") && required.Any(x => !outcomes.Contains(x))) return $"节点 {id} 必须配置默认出口或全部结果分支";
            }
            if (type == "serviceTask")
            {
                if (IntegrationWorkflowRunner.Text(node, "operationCode") == "review.requested" && !HasManualReviewPath(doc, id))
                    return "代码审查节点的 needs-review 出口必须到达人工复核任务，不能直接部署或结束";
                if (string.IsNullOrWhiteSpace(IntegrationWorkflowRunner.Text(node, "serviceCode")) || string.IsNullOrWhiteSpace(IntegrationWorkflowRunner.Text(node, "operationCode"))) return "第三方节点必须选择服务及操作";
                if (node!["timeoutSeconds"] is not JsonValue timeout || !timeout.TryGetValue<int>(out var seconds) || seconds is < 60 or > 604800) return "服务超时必须为 60–604800 秒";
                if (node["inputMappings"] is not null)
                {
                    if (node["inputMappings"] is not JsonObject mappings) return "输入映射必须是对象";
                    var allowed = new[] { "request.repositoryUrl", "request.branch", "request.commitSha", "request.version", "request.environment", "request.appName" };
                    if (mappings.Any(x => x.Value is not JsonValue value || !value.TryGetValue<string>(out var source) || !allowed.Contains(source))) return "输入映射只能引用申请业务字段";
                }
            }
            if (type == "gateway")
            {
                // No parallel split/join or expression execution in v1.
                if (outgoing.Length == 0 || !outcomes.Contains("")) return "网关需配置唯一默认出口和结果条件出口";
            }
        }
        // Reject automatic-only cycles, including unreachable result branches.
        var automatic = nodes.Where(n => IntegrationWorkflowRunner.Text(n, "type") is "start" or "gateway").Select(n => IntegrationWorkflowRunner.Text(n, "id")).ToHashSet();
        bool Cycle(string id, HashSet<string> path)
        {
            if (!automatic.Contains(id)) return false;
            if (!path.Add(id)) return true;
            foreach (var e in edges.Where(e => IntegrationWorkflowRunner.Text(e, "source") == id))
                if (Cycle(IntegrationWorkflowRunner.Text(e, "target"), new HashSet<string>(path))) return true;
            return false;
        }
        return automatic.Any(id => Cycle(id, [])) ? "自动节点不能形成循环" : null;
    }

    public static bool HasManualReviewPath(JsonNode document, string nodeId)
    {
        var visited = new HashSet<string>();
        while (visited.Add(nodeId))
        {
            var outgoing = document["edges"]!.AsArray().Where(e => IntegrationWorkflowRunner.Text(e, "source") == nodeId).ToArray();
            var selected = outgoing.FirstOrDefault(e => IntegrationWorkflowRunner.Text(e, "outcome") == "needs-review") ?? outgoing.FirstOrDefault(e => IntegrationWorkflowRunner.Text(e, "outcome") == "");
            if (selected is null) return false;
            nodeId = IntegrationWorkflowRunner.Text(selected, "target");
            var target = document["nodes"]!.AsArray().FirstOrDefault(n => IntegrationWorkflowRunner.Text(n, "id") == nodeId);
            if (IntegrationWorkflowRunner.Text(target, "type") == "userTask") return true;
            if (IntegrationWorkflowRunner.Text(target, "type") != "gateway") return false;
        }
        return false;
    }
}
