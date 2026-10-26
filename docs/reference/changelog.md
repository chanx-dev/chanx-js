---
outline: [2, 3]
---

<script setup>
import { data as changelogs } from './changelog.data.ts';
</script>

# Changelog

Each package has its own version and changelog. Majors follow chanx's: every 2.x package
speaks the chanx 2 protocol, so any 2.x client works with any 2.x server. Releases are
also on [GitHub](https://github.com/chanx-dev/chanx-js/releases).

## @chanx-js/server

<div v-html="changelogs.server" />

## @chanx-js/client

<div v-html="changelogs.client" />

## @chanx-js/codegen

<div v-html="changelogs.codegen" />

## @chanx-js/layers

<div v-html="changelogs.layers" />

## @chanx-js/nestjs

<div v-html="changelogs.nestjs" />

## Up to 2.0.0

Until 2.0.0, every package was released together, from one changelog.

<div v-html="changelogs.lockstep" />
