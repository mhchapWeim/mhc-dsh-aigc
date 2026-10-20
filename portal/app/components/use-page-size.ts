'use client';

import { useState } from 'react';

/** Shared list default; callers reset their page when changing the size. */
export function usePageSize() {
  return useState(5);
}
