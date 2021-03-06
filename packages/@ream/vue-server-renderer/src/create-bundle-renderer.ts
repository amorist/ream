import { PassThrough } from 'stream'
import { createBundleRunner } from './create-bundle-runner'
import {
  Renderer,
  RendererOptions,
  BundleRendererOptions,
} from 'vue-server-renderer'
import {
  createSourceMapConsumers,
  rewriteErrorTrace,
} from './source-map-support'

const INVALID_MSG =
  'Invalid server-rendering bundle format. Should be a string ' +
  'or a bundle Object of type:\n\n' +
  `{
  entry: string;
  files: { [filename: string]: string; };
  maps: { [filename: string]: string; };
}\n`

// The render bundle can either be a string (single bundled file)
// or a bundle manifest object generated by vue-ssr-webpack-plugin.
type RenderBundle = {
  basedir?: string
  entry: string
  files: { [filename: string]: string }
  maps: { [filename: string]: string }
  modules?: { [filename: string]: Array<string> }
}

export function createBundleRendererCreator(
  createRenderer: (options?: RendererOptions) => Renderer
) {
  return function createBundleRenderer(
    bundle: RenderBundle,
    rendererOptions: BundleRendererOptions = {}
  ) {
    let files, entry: string, maps: any
    let basedir = rendererOptions.basedir

    if (typeof bundle === 'object') {
      entry = bundle.entry
      files = bundle.files
      basedir = basedir || bundle.basedir
      maps = createSourceMapConsumers(bundle.maps)
      if (typeof entry !== 'string' || typeof files !== 'object') {
        throw new Error(INVALID_MSG)
      }
    } else {
      throw new Error(INVALID_MSG)
    }

    const renderer = createRenderer(rendererOptions)

    const runner = createBundleRunner(entry, files, basedir)

    const getServerEntryExports = () => {
      return runner.evaluate(entry)
    }

    return {
      runner,

      getServerEntryExports,

      rewriteErrorTrace: (err: Error) => {
        rewriteErrorTrace(err, maps)
      },

      renderToString: async (context: any) => {
        try {
          const { default: createApp } = runner.createAppFactory(context)
          const app = await createApp(context)

          if (app) {
            const html = await renderer.renderToString(app, context)
            return html
          }
        } catch (err) {
          rewriteErrorTrace(err, maps)
          throw err
        }
      },

      renderToStream: async (context: any) => {
        const res = new PassThrough()

        try {
          const { default: createApp } = runner.createAppFactory(context)

          const app = await createApp(context)

          const renderStream = renderer.renderToStream(app, context)

          renderStream.on('error', err => {
            rewriteErrorTrace(err, maps)
            res.emit('error', err)
          })

          // relay HTMLStream special events
          if (rendererOptions && rendererOptions.template) {
            renderStream.on('beforeStart', () => {
              res.emit('beforeStart')
            })
            renderStream.on('beforeEnd', () => {
              res.emit('beforeEnd')
            })
          }

          renderStream.pipe(res)
        } catch (err) {
          rewriteErrorTrace(err, maps)
          // avoid emitting synchronously before user can
          // attach error listener
          process.nextTick(() => {
            res.emit('error', err)
          })
        }

        return res
      },
    }
  }
}
