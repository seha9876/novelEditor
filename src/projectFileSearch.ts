import type { ProjectTreeNode, ProjectTreeSnapshot } from './projectTreeModel'

export type ProjectFileCandidate = {
  nodeId: number
  projectId: number
  name: string
  projectName: string
  folderPath: string
  path: string
}

export type ProjectFileSearchResult = { candidates: ProjectFileCandidate[]; total: number }
export const projectFileSearchLimit = 100

/** 比較時だけ全半角と英字の大小を揃え、原稿名やパスの元表記は変更しない。 */
function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** 展開状態に依存せず、保存済みのプロジェクト順・ツリー順で登録ファイルを列挙する。 */
export function createProjectFileCandidates(snapshot: ProjectTreeSnapshot): ProjectFileCandidate[] {
  const children = new Map<number | null, ProjectTreeNode[]>()
  for (const node of snapshot.nodes) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const candidates: ProjectFileCandidate[] = []
  const visited = new Set<number>()
  for (const project of snapshot.projects) {
    const roots = (children.get(null) ?? []).filter((node) => node.projectId === project.id)
    const pending = roots.slice().reverse().map((node) => ({ node, folderPath: '' }))
    while (pending.length) {
      const { node, folderPath } = pending.pop()!
      if (visited.has(node.id) || node.projectId !== project.id) continue
      visited.add(node.id)
      if (node.kind === 'folder') {
        const nextPath = folderPath ? `${folderPath} / ${node.name}` : node.name
        for (const child of (children.get(node.id) ?? []).slice().reverse()) {
          pending.push({ node: child, folderPath: nextPath })
        }
      } else if (node.path) {
        candidates.push({
          nodeId: node.id, projectId: project.id,
          name: node.name || node.path.split(/[\\/]/).pop() || node.path,
          projectName: project.name, folderPath, path: node.path,
        })
      }
    }
  }
  return candidates
}

/** 全一致数を維持して表示分だけ返す。本文読込や実ファイルの存在確認は行わない。 */
export function searchProjectFiles(
  candidates: readonly ProjectFileCandidate[],
  query: string,
  projectId: number | null,
  allProjects: boolean,
): ProjectFileSearchResult {
  const search = normalizeSearchText(query.trim())
  const result: ProjectFileSearchResult = { candidates: [], total: 0 }
  for (const candidate of candidates) {
    if (!allProjects && candidate.projectId !== projectId) continue
    if (!normalizeSearchText(candidate.name).includes(search)) continue
    result.total += 1
    if (result.candidates.length < projectFileSearchLimit) result.candidates.push(candidate)
  }
  return result
}
