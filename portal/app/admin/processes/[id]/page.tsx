import { ProcessDesigner } from "../process-designer";

export default async function ProcessVersionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProcessDesigner key={id} versionId={id} />;
}
