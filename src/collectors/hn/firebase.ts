// Firebase API client for the HN item tree.
//
// One function per item type so callers see what they're fetching at the
// call site. Both functions return the raw decoded JSON; the parser owns
// the comment -> lead transform.

import type { HttpClient } from "../../http/index.ts";
import type { FirebaseCommentItem } from "./parse.ts";

export const FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0/item";

export interface FirebaseStoryItem {
  id: number;
  type?: string;
  title?: string;
  kids?: number[];
  time?: number;
  by?: string;
}

export function itemUrl(itemId: number | string): string {
  return `${FIREBASE_BASE}/${itemId}.json`;
}

export async function fetchStory(
  client: HttpClient,
  postId: string,
): Promise<FirebaseStoryItem> {
  const response = await client.get(itemUrl(postId));
  return JSON.parse(response.body) as FirebaseStoryItem;
}

export async function fetchComment(
  client: HttpClient,
  commentId: number,
): Promise<FirebaseCommentItem> {
  const response = await client.get(itemUrl(commentId));
  return JSON.parse(response.body) as FirebaseCommentItem;
}
