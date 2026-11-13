export type MaintenanceWindows = {
  /** claimExternalTasks のリース満了までの猶予。DB 側の INTERVAL と一致させる。 */
  leaseMs: number;
  /** uploading のまま放置された行を放棄とみなすまでの時間。 */
  abandonedUploadMs: number;
  /** queued のまま配送タスクが尽きた招待を failed に倒すまでの猶予。 */
  staleInvitationMs: number;
};

export type MaintenanceWakeup = {
  /** 期限切れを含む最も早い期限。対象が無ければ null。 */
  nextAt: Date | null;
  /** DB 問い合わせ時点で未来にある最も早い期限。該当が無ければ null。 */
  nextFutureAt: Date | null;
};


export interface MaintenanceRepository {
  getNextWakeup(windows: MaintenanceWindows): Promise<MaintenanceWakeup>;
}
