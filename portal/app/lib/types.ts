export type AppCategory = string;

export type PortalApp = {
  subcategory?: string; subcategoryId?: string | null;
  clicks?: import('./application-registry').ClickCounts;
  /** Lifetime clicks; absent for applications that never recorded one. */
  totalClicks?: number;
  id: string;
  name: string;
  nameEn?: string;
  descriptionEn?: string;
  ownerEn?: string;
  categoryEn?: string;
  registered?: boolean;
  description: string;
  category: AppCategory;
  tags: string[];
  owner: string;
  accessUrl: string;
  launchable?: boolean;
  slug?: string;
  publishedAt: string;
  status: '运行中';
  accent: string;
};
