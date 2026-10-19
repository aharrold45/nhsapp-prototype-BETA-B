// External dependencies
const browserSync = require('browser-sync')
const gulp = require('gulp')
const babel = require('gulp-babel')
const clean = require('gulp-clean')
const nodemon = require('gulp-nodemon')
const gulpSass = require('gulp-sass')
const { Transform } = require('stream')
const PluginError = require('plugin-error')
const dartSass = require('sass-embedded')

// Local dependencies
const config = require('./app/config')
const { findAvailablePort } = require('./lib/utils')

// Set configuration variables
const port = parseInt(process.env.PORT || config.port, 10) || 2000

// Delete all the files in /public build directory
function cleanPublic() {
  return gulp.src('public', { allowEmpty: true }).pipe(clean())
}

// Set Sass compiler
const sass = gulpSass(dartSass)

// The prototype should always show the NHS App mobile type scale, even in a
// desktop browser. Strip font-size / line-height declarations from the
// tablet and desktop media queries so the mobile values always apply.
function forceMobileFontSizes() {
  const opener = /@media \(min-width: (?:40\.0625em|48\.0625em)\) \{/g
  return new Transform({
    objectMode: true,
    transform(file, _enc, cb) {
      if (file.isBuffer() && file.extname === '.css') {
        const css = file.contents.toString()
        let out = ''
        let last = 0
        let match
        opener.lastIndex = 0
        while ((match = opener.exec(css))) {
          let depth = 1
          let i = opener.lastIndex
          while (depth > 0 && i < css.length) {
            if (css[i] === '{') depth++
            else if (css[i] === '}') depth--
            i++
          }
          const block = css
            .slice(match.index, i)
            .replace(/^[ \t]*(?:font-size|line-height):[^;{}]*;[ \t]*\n/gm, '')
          out += css.slice(last, match.index) + block
          last = i
          opener.lastIndex = i
        }
        file.contents = Buffer.from(out + css.slice(last))
      }
      cb(null, file)
    }
  })
}

// Compile SASS to CSS
function compileStyles() {
  return gulp
    .src(['app/assets/sass/**/*.scss'], {
      sourcemaps: true
    })
    .pipe(
      sass({
        loadPaths: ['node_modules'],
        sourceMap: true,
        sourceMapIncludeSources: true
      }).on('error', (error) => {
        throw new PluginError('compileCSS', error.messageFormatted, {
          showProperties: false
        })
      })
    )
    .pipe(forceMobileFontSizes())
    .pipe(
      gulp.dest('public/css', {
        sourcemaps: '.'
      })
    )
}

// Compile JavaScript (with ES6 support)
function compileScripts() {
  return gulp
    .src(['app/assets/javascript/**/*.js'], {
      sourcemaps: true
    })
    .pipe(babel())
    .pipe(
      gulp.dest('public/js', {
        sourcemaps: '.'
      })
    )
}

// Compile assets
function compileAssets() {
  return gulp
    .src(
      [
        'app/assets/**/**/*.*',
        '!**/assets/**/**/*.js', // Don't copy JS files
        '!**/assets/**/**/*.scss' // Don't copy SCSS files
      ],
      { encoding: false }
    )
    .pipe(gulp.dest('public'))
}

// Start nodemon
async function startNodemon(done) {
  let availablePort

  try {
    availablePort = await findAvailablePort(port)
    if (!availablePort) {
      throw new Error(`Port ${port} in use`)
    }
  } catch (error) {
    done(new PluginError('startNodemon', error))
    return
  }

  process.env.PORT = availablePort
  process.env.WATCH = 'true'

  const server = nodemon({
    script: 'app.js',
    stdout: true,
    ext: 'js json',
    watch: ['.env', 'app.js', 'app', 'lib'],
    ignore: ['app/assets', '**.test.*'],
    quiet: false
  })

  let starting = false

  const onReady = () => {
    starting = false
    done()
  }

  server.on('start', () => {
    starting = true
    setTimeout(onReady)
  })

  server.on('stdout', (stdout) => {
    process.stdout.write(stdout)
    if (starting) {
      onReady()
    }
  })
}

// Start browsersync
async function startBrowserSync(done) {
  const proxyPort = parseInt(process.env.PORT, 10)

  browserSync.init(
    {
      proxy: `localhost:${proxyPort}`,
      port: proxyPort + 1000,
      ui: false,
      files: ['app/views/**/*.*', 'lib/example-templates/**/*.*'],
      ghostMode: false,
      open: false,
      notify: true,
      watch: true
    },
    done
  )

  gulp.watch('public/**/*.*').on('change', browserSync.reload)
}

// Watch for changes within assets/
function watch() {
  gulp.watch('app/assets/sass/**/*.scss', compileStyles)
  gulp.watch('app/assets/javascript/**/*.js', compileScripts)
  gulp.watch('app/assets/**/**/*.*', compileAssets)
}

exports.watch = watch
exports.compileStyles = compileStyles
exports.compileScripts = compileScripts
exports.cleanPublic = cleanPublic

gulp.task(
  'build',
  gulp.series(cleanPublic, compileStyles, compileScripts, compileAssets)
)

gulp.task('default', gulp.series(startNodemon, startBrowserSync, watch))
