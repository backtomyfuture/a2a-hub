import { defineRailway, project, service, volume } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "a2a-hub";
export default defineRailway(() => {
  const data = volume("lobe-a2a-hub-volume", { region: "us-west2", sizeMB: 5000 });
  const a2aHub = service("a2a-hub", {
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/v1/health",
    healthcheckTimeout: 60,
    replicas: { "us-west2": 1 },
    networking: { privateNetworkEndpoint: "lobe-a2a-hub" },
    // Hub 的 SQLite 与密钥都在 /data，漏掉挂载声明会让 IaC 把数据卷摘掉
    volumeMounts: { "/data": data },
  });

  return project("a2a-hub", {
    variables: { managed: false },
    resources: [a2aHub, data],
  });
});
