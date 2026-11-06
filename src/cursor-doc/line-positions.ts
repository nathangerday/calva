/** Implicit treap of line lengths. Retained nodes resolve their current row and
 * offset after a splice without rewriting every following bracket's position.
 */
export class LinePosition<T> {
  left?: LinePosition<T>;
  right?: LinePosition<T>;
  parent?: LinePosition<T>;
  count = 1;
  size: number;

  constructor(public length: number, readonly priority: number, readonly value: T) {
    this.size = length;
  }

  get row(): number {
    return rowBefore(this);
  }

  get offset(): number {
    return offsetBefore(this);
  }

  refresh() {
    this.count = 1 + (this.left?.count ?? 0) + (this.right?.count ?? 0);
    this.size = this.length + (this.left?.size ?? 0) + (this.right?.size ?? 0);
    if (this.left) {
      this.left.parent = this;
    }
    if (this.right) {
      this.right.parent = this;
    }
    this.parent = undefined;
  }
}

function rowBefore<T>(node: LinePosition<T>): number {
  let result = node.left?.count ?? 0;
  for (; node.parent; node = node.parent) {
    if (node === node.parent.right) {
      result += 1 + (node.parent.left?.count ?? 0);
    }
  }
  return result;
}

function offsetBefore<T>(node: LinePosition<T>): number {
  let result = node.left?.size ?? 0;
  for (; node.parent; node = node.parent) {
    if (node === node.parent.right) {
      result += node.parent.length + (node.parent.left?.size ?? 0);
    }
  }
  return result;
}

function merge<T>(a?: LinePosition<T>, b?: LinePosition<T>): LinePosition<T> | undefined {
  if (!a || !b) {
    const root = a ?? b;
    if (root) {
      root.parent = undefined;
    }
    return root;
  }
  if (a.priority < b.priority) {
    a.right = merge(a.right, b);
    a.refresh();
    return a;
  }
  b.left = merge(a, b.left);
  b.refresh();
  return b;
}

function split<T>(root: LinePosition<T>, count: number): [LinePosition<T>?, LinePosition<T>?] {
  if (!root) {
    return [];
  }
  const leftCount = root.left?.count ?? 0;
  if (count <= leftCount) {
    const [a, b] = split(root.left, count);
    root.left = b;
    root.refresh();
    return [a, root];
  }
  const [a, b] = split(root.right, count - leftCount - 1);
  root.right = a;
  root.refresh();
  return [root, b];
}

export class LinePositions<T> {
  private root?: LinePosition<T>;
  private seed = 0x41c6ce57;

  node(length: number, value: T): LinePosition<T> {
    // Reproducible priorities without depending on the model's line numbers.
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    return new LinePosition(length, this.seed >>> 0, value);
  }

  private tree(nodes: LinePosition<T>[]): LinePosition<T> | undefined {
    const stack: LinePosition<T>[] = [];
    for (const node of nodes) {
      let left: LinePosition<T>;
      while (stack.length && stack[stack.length - 1].priority > node.priority) {
        left = stack.pop();
      }
      node.left = left;
      if (stack.length) {
        stack[stack.length - 1].right = node;
      }
      stack.push(node);
    }
    const refresh = (node?: LinePosition<T>) => {
      if (node) {
        refresh(node.left);
        refresh(node.right);
        node.refresh();
      }
    };
    refresh(stack[0]);
    return stack[0];
  }

  splice(start: number, deleted: number, inserted: LinePosition<T>[]) {
    const [before, rest] = split(this.root, start);
    const [, after] = split(rest, deleted);
    this.root = merge(merge(before, this.tree(inserted)), after);
  }

  range(start: number, count: number): LinePosition<T>[] {
    const result: LinePosition<T>[] = [];
    const visit = (node: LinePosition<T>, base: number) => {
      if (!node || base >= start + count || base + node.count <= start) {
        return;
      }
      const row = base + (node.left?.count ?? 0);
      visit(node.left, base);
      if (row >= start && row < start + count) {
        result.push(node);
      }
      visit(node.right, row + 1);
    };
    visit(this.root, 0);
    return result;
  }
}
