import { useEffect, useRef } from 'react'
import * as d3 from 'd3-force'
import type { VaultGraph } from '../../../shared/ipc.js'

/**
 * Graph view — force-directed graph of wikilinks.
 * Canvas-based rendering with d3-force simulation.
 * ponytail: no interaction, dragging, or zoom for v1 — just visualization.
 */
export interface GraphViewProps {
  graph: VaultGraph | null
}

export function GraphView({ graph }: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!graph || !canvasRef.current) return

    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width
    canvas.height = rect.height

    // ponytail: O(n) per render. Acceptable for low hundreds of notes.
    // For 1000+ notes, add scene graph caching.
    const nodes = graph.nodes.map((id) => ({ id }))
    const links = graph.links.map((l) => ({
      source: l.from,
      target: l.to,
    }))

    const sim = d3
      .forceSimulation<d3.SimulationNodeDatum & { id: string }>(nodes as any)
      .force(
        'link',
        d3
          .forceLink<
            d3.SimulationNodeDatum & { id: string },
            d3.SimulationLinkDatum<d3.SimulationNodeDatum & { id: string }>
          >(links as any)
          .id((d: any) => d.id)
          .distance(80),
      )
      .force('charge', d3.forceManyBody().strength(-300))
      .force('center', d3.forceCenter(canvas.width / 2, canvas.height / 2))

    const render = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Draw links. forceLink() REPLACES link.source/link.target with the node
      // objects themselves, so looking them up by id afterwards never matches
      // and no edge was ever drawn. Read the resolved objects directly.
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.6
      for (const link of links as unknown as Array<{ source: unknown; target: unknown }>) {
        const source = link.source as { x?: number; y?: number } | undefined
        const target = link.target as { x?: number; y?: number } | undefined
        if (
          source &&
          target &&
          typeof source.x === 'number' &&
          typeof source.y === 'number' &&
          typeof target.x === 'number' &&
          typeof target.y === 'number'
        ) {
          ctx.beginPath()
          ctx.moveTo(source.x, source.y)
          ctx.lineTo(target.x, target.y)
          ctx.stroke()
        }
      }

      // Draw nodes
      ctx.globalAlpha = 1
      for (const node of nodes) {
        if ('x' in node && 'y' in node) {
          ctx.beginPath()
          ctx.arc(node.x as number, node.y as number, 4, 0, 2 * Math.PI)
          ctx.fill()
        }
      }
    }

    sim.on('tick', render)

    return () => {
      sim.stop()
    }
  }, [graph])

  if (!graph) {
    return <div className="vault-graph-empty">No graph data</div>
  }

  return (
    <div className="vault-graph-view">
      <canvas ref={canvasRef} className="vault-graph-canvas" />
      <div className="vault-graph-info">
        {graph.nodes.length} notes, {graph.links.length} links
      </div>
    </div>
  )
}
