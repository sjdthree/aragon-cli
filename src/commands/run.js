const TaskList = require('listr')
const ganache = require('ganache-core')
const Web3 = require('web3')
const namehash = require('eth-ens-namehash')
const { keccak256 } = require('js-sha3')
const chalk = require('chalk')
const path = require('path')
const APM = require('@aragon/apm')
const publish = require('./publish')
const devchain = require('./devchain')
const { promisify } = require('util')
const clone = promisify(require('git-clone'))
const os = require('os')
const fs = require('fs-extra')
const openUrl = require('opn')
const execa = require('execa')
const opn = require('opn')
const { runTruffle } = require('../helpers/truffle-runner')
const { isIPFSRunning, isIPFSInstalled, startIPFSDaemon } = require('../helpers/ipfs-daemon')

const TX_MIN_GAS = 10e6

exports.command = 'run'

exports.describe = 'Run the current app locally'

exports.builder = {
  port: {
    description: 'The port to run the local chain on',
    default: 8545
  }
}

function getContract (pkg, contract) {
  const artifact = require(`${pkg}/build/contracts/${contract}.json`)
  return artifact
}

function deployContract (web3, sender, { abi, bytecode }, args = []) {
  const contract = new web3.eth.Contract(abi)

  return contract.deploy({
    data: bytecode,
    arguments: args
  }).send({
    from: sender,
    gas: TX_MIN_GAS
  }).then((instance) => {
    return instance.options.address
  })
}

async function setPermissions (web3, sender, aclAddress, permissions) {
  const acl = new web3.eth.Contract(
    getContract('@aragon/os', 'ACL').abi,
    aclAddress
  )
  return Promise.all(
    permissions.map(([who, where, what]) =>
      acl.methods.createPermission(who, where, '0x' + keccak256(what), who).send({
        from: sender,
        gasLimit: TX_MIN_GAS
      })
    )
  )
}

exports.handler = function (args) {
  const {
    // Globals
    reporter,
    cwd,
    module,

    // Arguments
    port
  } = args
  const tasks = new TaskList([
    {
      title: 'Compile contracts',
      task: async () => {
        await runTruffle(['compile'], { stdout: null })
      }
    },
    {
      title: 'Connect to the development chain',
      task: async (ctx, task) => {
        const getWeb3 = () => new Web3(
          new Web3.providers.WebsocketProvider(`ws://localhost:8545`)
        )

        try {
          ctx.web3 = getWeb3()
          const connected = await ctx.web3.eth.net.isListening()
          return connected
        } catch (err) {
          await devchain.task({}).then(() => {
            ctx.web3 = getWeb3()
          })
        }
      }
    },
    {
      title: 'Start IPFS',
      skip: async () => {
        const running = await isIPFSRunning()
        if (running) return 'IPFS daemon already running'
      },
      task: async () => {
        const installed = await isIPFSInstalled()
        if (!installed) {
          setTimeout(() => opn('https://ipfs.io/docs/install'), 3000)
          throw new Error(`
            Running your app requires IPFS. Opening install instructions in your browser`
          )
        } else {
          startIPFSDaemon()
        }
      }
    },
    {
      title: 'Deploy APM and ENS',
      task: (ctx, task) => new TaskList([
        {
          title: 'Deploy base contracts',
          task: (ctx, task) => {
            ctx.contracts = {}
            const apmBaseContracts = [
              ['@aragon/os', 'APMRegistry'],
              ['@aragon/os', 'Repo'],
              ['@aragon/os', 'ENSSubdomainRegistrar'],
              ['@aragon/os', 'ENSFactory'],
              ['@aragon/os', 'Kernel'],
              ['@aragon/os', 'ACL']
            ]
              .map(([pkg, contractName]) => getContract(pkg, contractName))
              .map((artifact) =>
                deployContract(ctx.web3, ctx.accounts[0], artifact).then((contractAddress) => {
                  task.title = `Deployed ${artifact.contractName} to ${contractAddress}`

                  ctx.contracts[artifact.contractName] = contractAddress
                })
              )

            return Promise.all(
              apmBaseContracts
            )
          }
        },
        {
          title: 'Deploy base DAO factory',
          task: (ctx) => {
            // TODO: 0x0 should be address to EVMScriptRegistryFactory
            return deployContract(
              ctx.web3, ctx.accounts[0], getContract('@aragon/os', 'DAOFactory'), [
                ctx.contracts['Kernel'], ctx.contracts['ACL'], '0x0'
              ]
            ).then((daoFactoryAddress) => {
              ctx.contracts['DAOFactory'] = daoFactoryAddress
            })
          }
        },
        {
          title: 'Deploy APM registry factory',
          task: (ctx, task) => {
            return deployContract(
              ctx.web3, ctx.accounts[0], getContract('@aragon/os', 'APMRegistryFactory'), [
                ctx.contracts['DAOFactory'],
                ctx.contracts['APMRegistry'],
                ctx.contracts['Repo'],
                ctx.contracts['ENSSubdomainRegistrar'],
                '0x0',
                ctx.contracts['ENSFactory']
              ]
            ).then((apmRegistryAddress) => {
              ctx.contracts['APMRegistryFactory'] = apmRegistryAddress
            })
          }
        },
        {
          title: 'Create APM registry',
          task: (ctx) => {
            const root = '0xffffffffffffffffffffffffffffffffffffffff'
            const contract = new ctx.web3.eth.Contract(
              getContract('@aragon/os', 'APMRegistryFactory').abi,
              ctx.contracts['APMRegistryFactory']
            )

            // TODO: Create repo from appName repository
            return contract.methods.newAPM(
              namehash.hash('eth'),
              '0x' + keccak256('aragonpm'),
              root
            ).send({
              from: ctx.accounts[0],
              gas: TX_MIN_GAS
            }).then(({ events }) => {
              ctx.registryAddress = events['DeployAPM'].returnValues.apm

              const registry = new ctx.web3.eth.Contract(
                getContract('@aragon/os', 'APMRegistry').abi,
                ctx.registryAddress
              )
              return registry.methods.registrar().call()
            }).then((registrarAddress) => {
              const registrar = new ctx.web3.eth.Contract(
                getContract('@aragon/os', 'ENSSubdomainRegistrar').abi,
                registrarAddress
              )

              return registrar.methods.ens().call()
            }).then((ensAddress) => {
              ctx.ensAddress = ensAddress
            })
          }
        }
      ])
    },
    {
      title: 'Create DAO',
      task: (ctx, task) => {
        const factory = new ctx.web3.eth.Contract(
          getContract('@aragon/os', 'DAOFactory').abi,
          ctx.contracts['DAOFactory']
        )

        return factory.methods.newDAO(
          ctx.accounts[0]
        ).send({
          from: ctx.accounts[0],
          gas: TX_MIN_GAS
        }).then(({ events }) => {
          ctx.daoAddress = events['DeployDAO'].returnValues.dao

          const kernel = new ctx.web3.eth.Contract(
          getContract('@aragon/os', 'Kernel').abi,
            ctx.daoAddress
          )
          return kernel.methods.acl().call()
        }).then((aclAddress) => {
          ctx.aclAddress = aclAddress
        })
      }
    },
    {
      title: 'Set DAO permissions',
      task: (ctx, task) =>
        setPermissions(ctx.web3, ctx.accounts[0], ctx.aclAddress, [
          [ctx.accounts[0], ctx.daoAddress, 'APP_MANAGER_ROLE']
        ])
    },
    {
      title: 'Deploy app code',
      task: (ctx, task) => deployContract(ctx.web3, ctx.accounts[0], getContract(cwd, path.basename(module.path, '.sol'))
      ).then((appCodeAddress) => {
        ctx.contracts['AppCode'] = appCodeAddress
      })
    },
    // TODO: Clean this up
    {
      title: 'Publish app',
      task: (ctx) => {
        ctx.apm = APM(ctx.web3, {
          ipfs: { host: 'localhost', port: 5001, protocol: 'http' },
          ensRegistryAddress: ctx.ensAddress
        })
        ctx.privateKey = ctx.privateKeys[ctx.accounts[0].toLowerCase()].secretKey.toString('hex')
        return publish.task(Object.assign(args, {
          alreadyCompiled: true,
          contract: ctx.contracts['AppCode'],
          provider: 'ipfs',
          files: ['.'],
          ignore: ['node_modules']
        }))
      }
    },
    {
      title: 'Install app',
      task: () => new TaskList([
        {
          title: 'Deploy proxy',
          task: (ctx) => {
            const kernel = new ctx.web3.eth.Contract(
              getContract('@aragon/os', 'Kernel').abi,
              ctx.daoAddress
            )

            return kernel.methods.newAppInstance(
              namehash.hash(module.appName),
              ctx.contracts['AppCode']
            ).send({
              from: ctx.accounts[0],
              gasLimit: TX_MIN_GAS
            }).then(({ events }) => {
              ctx.appAddress = events['NewAppProxy'].returnValues.proxy
            })
          }
        },
        {
          title: 'Set permissions',
          task: async (ctx, task) => {
            if (!module.roles || module.roles.length === 0) {
              task.skip('No permissions defined in app')
              return
            }

            const permissions = module.roles
              .map((role) => [ctx.accounts[0], ctx.appAddress, role.id])

            return setPermissions(
              ctx.web3,
              ctx.accounts[0],
              ctx.aclAddress,
              permissions
            )
          }
        }
      ])
    },
    {
      title: 'Open DAO',
      task: (ctx, task) => new TaskList([
        {
          title: 'Download wrapper',
          task: (ctx, task) => {
            const WRAPPER_COMMIT = 'ddecab6aa3c9d345ee22fc70395be68b99dba6e7'
            const WRAPPER_PATH = `${os.homedir()}/.aragon/wrapper-${WRAPPER_COMMIT}`
            ctx.wrapperPath = WRAPPER_PATH

            // Make sure we haven't already downloaded the wrapper
            if (fs.existsSync(path.resolve(WRAPPER_PATH))) {
              task.skip('Wrapper already downloaded')
              ctx.wrapperAvailable = true
              return
            }

            // Ensure folder exists
            fs.ensureDirSync(WRAPPER_PATH)

            // Clone wrapper
            return clone(
              'https://github.com/aragon/aragon',
              WRAPPER_PATH,
              { checkout: WRAPPER_COMMIT }
            )
          }
        },
        {
          title: 'Install wrapper dependencies with npm',
          task: () => execa('npm', ['install'], { cwd: ctx.wrapperPath })
            .catch(() => {
              throw new Error('Could not install dependencies')
            }),
          enabled: (ctx) => !ctx.wrapperAvailable
        },
        {
          title: 'Start wrapper',
          task: (ctx, task) => {
            execa(
              'npm',
              ['start'],
              {
                cwd: ctx.wrapperPath,
                env: {
                  BROWSER: 'none',
                  REACT_APP_IPFS_GATEWAY: 'http://localhost:5001',
                  REACT_APP_DEFAULT_ETH_NODE: `ws://localhost:${port}`,
                  REACT_APP_ENS_REGISTRY_ADDRESS: ctx.ensAddress
                }
              }
            ).catch((err) => {
              throw new Error('Could not start wrapper')
            })
          }
        },
        {
          title: 'Open wrapper',
          task: (ctx) => {
            openUrl(`http://localhost:3000/#/${ctx.daoAddress}`)
          }
        }
      ])
    }
  ])

  return tasks.run().then((ctx) => {
    reporter.info(`You are now ready to open your app in Aragon.

   This is the configuration for your development deployment:
   ${chalk.bold('Ethereum Node')}: ws://localhost:${port}
   ${chalk.bold('APM registry')}: ${ctx.registryAddress}
   ${chalk.bold('ENS registry')}: ${ctx.ensAddress}
   ${chalk.bold('DAO address')}: ${ctx.daoAddress}

   Here are some accounts you can use.
   The first one was used to create everything.

   ${Object.keys(ctx.privateKeys).map((address) =>
      chalk.bold(`Address: ${address}\n   Key:   `) + ctx.privateKeys[address].secretKey.toString('hex')).join('\n   ')}

   Open up http://localhost:3000/#/${ctx.daoAddress} to view your DAO!`)
    if (!manifest) {
      reporter.warning('No front-end detected (no manifest.json)')
    } else if (!manifest.start_url) {
      reporter.warning('No front-end detected (no start_url defined)')
    }
  })
}
