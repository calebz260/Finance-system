import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names, letting a caller's classes win over a component's
 * defaults instead of both ending up in the class list and fighting.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
