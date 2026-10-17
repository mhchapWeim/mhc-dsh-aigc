export type AppCategory = string;

export type PortalApp = {
  id: string;
  name: string;
  description: string;
  category: AppCategory;
  tags: string[];
  owner: string;
  accessUrl: string;
  publishedAt: string;
  status: '运行中';
  accent: string;
};
