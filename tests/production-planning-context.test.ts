import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { planningProjectContext } from '../src/main/services/production-planning-context'
import type { ProjectSnapshot } from '../src/main/services/project-snapshot'

test('Planner context selects the entry scene and related code without addons or credentials', () => {
  const files: ProjectSnapshot['files'] = new Map([
    ['project.godot',{hash:'a',text:'run/main_scene="res://scenes/main.tscn"'}],
    ['scenes/main.tscn',{hash:'b',text:'[ext_resource type="Script" path="res://scripts/player.gd" id="1"]'}],
    ['scripts/player.gd',{hash:'c',text:'extends Node2D'}],
    ['scripts/unused.gd',{hash:'d',text:'UNUSED BODY'}],
    ['addons/godot_ai/plugin.cfg',{hash:'e',text:'ADDON BODY'}],
    ['auth.cfg',{hash:'f',text:'PRIVATE BODY'}],
    ['assets/library/source.gd',{hash:'g',text:'LIBRARY BODY'}]
  ])
  const result = planningProjectContext({revision:'a'.repeat(64),files,complete:true,issues:[],durationMs:0},'Make the player move')
  assert.deepEqual(result.sources.map(file=>file.path),['project.godot','scenes/main.tscn','scripts/player.gd'])
  const text = JSON.stringify(result)
  for (const content of ['UNUSED BODY','ADDON BODY','PRIVATE BODY','LIBRARY BODY']) assert.ok(!text.includes(content))
  assert.equal(result.revision,'a'.repeat(64))
})
test('Large context is explicitly truncated and incomplete snapshots are rejected', () => {
  const snapshot: ProjectSnapshot = {revision:'a'.repeat(64),complete:true,issues:[],durationMs:0,files:new Map([['project.godot',{hash:'b',text:'x'.repeat(40_000)}]])}
  const result = planningProjectContext(snapshot,'Explain the project')
  assert.equal(result.sources[0].truncated,true); assert.equal(result.sources[0].text.length,16_000)
  assert.throws(()=>planningProjectContext({...snapshot,complete:false},'Explain'))
})
