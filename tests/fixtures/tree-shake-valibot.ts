import { vProject } from '@oore/client/valibot'
import { safeParse } from 'valibot'

export const parseProject = (input: unknown) => safeParse(vProject, input)
