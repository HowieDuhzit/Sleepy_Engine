export type LevelHistorySnapshot<TScene> = {
  scenes: TScene[];
  activeSceneName: string | null;
  selectedObjectId: string | null;
};

const cloneSnapshot = <TScene>(snapshot: LevelHistorySnapshot<TScene>): LevelHistorySnapshot<TScene> =>
  JSON.parse(JSON.stringify(snapshot)) as LevelHistorySnapshot<TScene>;

const serializeSnapshot = <TScene>(snapshot: LevelHistorySnapshot<TScene>): string =>
  JSON.stringify(snapshot);

export const areLevelHistorySnapshotsEqual = <TScene>(
  left: LevelHistorySnapshot<TScene>,
  right: LevelHistorySnapshot<TScene>,
): boolean => serializeSnapshot(left) === serializeSnapshot(right);

export class LevelHistory<TScene> {
  private undoStack: LevelHistorySnapshot<TScene>[] = [];
  private redoStack: LevelHistorySnapshot<TScene>[] = [];

  constructor(private readonly limit = 100) {}

  public push(snapshot: LevelHistorySnapshot<TScene>): boolean {
    const cloned = cloneSnapshot(snapshot);
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && areLevelHistorySnapshotsEqual(top, cloned)) return false;
    this.undoStack.push(cloned);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return true;
  }

  public undo(current: LevelHistorySnapshot<TScene>): LevelHistorySnapshot<TScene> | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(cloneSnapshot(current));
    return cloneSnapshot(previous);
  }

  public redo(current: LevelHistorySnapshot<TScene>): LevelHistorySnapshot<TScene> | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneSnapshot(current));
    return cloneSnapshot(next);
  }

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  public getUndoCount() {
    return this.undoStack.length;
  }

  public getRedoCount() {
    return this.redoStack.length;
  }

  public canUndo() {
    return this.undoStack.length > 0;
  }

  public canRedo() {
    return this.redoStack.length > 0;
  }
}
