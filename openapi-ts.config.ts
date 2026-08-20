import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './openapi/openapi.json',
  output: {
    clean: true,
    entryFile: false,
    importFileExtension: '.js',
    path: './src/generated',
  },
  plugins: [
    '@hey-api/typescript',
    {
      bundle: true,
      name: '@hey-api/client-fetch',
      throwOnError: true,
    },
    {
      name: '@hey-api/sdk',
      operations: { strategy: 'flat' },
      paramsStructure: 'grouped',
      responseStyle: 'data',
    },
    {
      name: '@tanstack/react-query',
      mutationKeys: { tags: true },
      mutationOptions: true,
      queryKeys: { tags: true },
      queryOptions: true,
      useMutation: true,
      useQuery: true,
    },
    {
      metadata: false,
      name: 'valibot',
    },
    {
      name: 'msw',
      responseFallback: 'error',
      source: [],
    },
  ],
})
