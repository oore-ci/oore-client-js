import { expect, test } from 'bun:test'
import * as v from 'valibot'

import { vProject } from '../src/valibot.js'

test('the generated Project schema accepts the public Project shape', () => {
  const result = v.safeParse(vProject, {
    created_at: 1_700_000_000,
    created_by: 'user-1',
    current_user_role: 'maintainer',
    id: 'project-1',
    name: 'Oore macOS',
    settings: {},
    updated_at: 1_700_000_100,
  })

  expect(result.success).toBe(true)
})
