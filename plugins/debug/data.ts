export type CheckItem = {
  id: string;
  label: string;
  cmd: string;
  status: 'ok' | 'fail' | 'pending';
  ms: number | null;
};

export type QueueItem = {
  id: string;
  source: 'problem' | 'check';
  sourceId: string;
  label: string;
  detail?: string;
  status: 'pending' | 'fixing' | 'sent' | 'failed';
};

export const FIX_ITEM_MIME = 'application/x-fix-item';
export const QUEUE_ITEM_MIME = 'application/x-queue-item';
