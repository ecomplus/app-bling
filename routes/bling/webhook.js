'use strict'

const getConfig = require(process.cwd() + '/lib/store-api/get-config')
const handleBlingCallback = require(process.cwd() + '/lib/bling/handle-callback')
const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'
const logger = require('console-files')
const { randomObjectId } = require('@ecomplus/utils')
const processQueue = []

module.exports = (appSdk, database) => {
  return (req, res) => {
    const { storeId } = req.query
    let { data } = req.body
    if (!data) {
      return res.sendStatus(400)
    }
    // logger.log(`Bling webhook #${storeId}`)
    const failed = []
    // get app configured options
    getConfig({ appSdk, storeId }, true)
      .then(configObj => {
        if (configObj.bling_api_key) {
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data)
            } catch (e) {
              // ignore invalid JSON
            }
          }
          if (!data || !data.retorno) {
            return res.sendStatus(400)
          }
          const { retorno } = data

          if (
            Array.isArray(retorno.estoques) &&
            configObj.sync &&
            configObj.sync.bling &&
            configObj.sync.bling.stock
          ) {
            // update product stock
            retorno.estoques.forEach((estoque, i) => {
              if (estoque && estoque.estoque) {
                setTimeout(() => {
                  const apiKey = configObj.bling_api_key
                  handleBlingCallback(appSdk, storeId, apiKey, estoque.estoque, database)
                }, 1000 * i)
              }
            })
          } else if (retorno.pedidos) {
            const { sync } = configObj
            // update orders
            const trigger = retorno.pedidos[0].pedido
            let resource = `/orders.json?number=${(trigger.numeroPedidoLoja || trigger.numero)}` +
              '&fields=_id,number,status,financial_status,fulfillment_status,shipping_lines' +
              ',buyers,items,hidden_metafields'
            const method = 'GET'

            if (processQueue.indexOf(trigger.numero) === -1 && sync && sync.bling) {
              setTimeout(() => {
                appSdk
                  .apiRequest(storeId, resource, method)
                  .then(resp => resp.response.data.result)
                  .then(result => {
                    const promises = []
                    const order = result[0]

                    if (order) {
                      if (trigger.nota && sync.bling.invoices) {
                        // verifica se a nota ja existe na order
                        const shippingInvoices = order.shipping_lines.find(shippin => shippin.invoices)
                        let match
                        if (shippingInvoices) {
                          match = shippingInvoices.invoices
                            .find(invoice => invoice.number === trigger.nota.chaveAcesso)
                        }

                        if (!shippingInvoices || !match) {
                          const update = [
                            {
                              number: trigger.nota.numero,
                              serial_number: trigger.nota.numero,
                              access_key: trigger.nota.chaveAcesso || ''
                            }
                          ]
                          resource = `/orders/${order._id}/shipping_lines/${order.shipping_lines[0]._id}.json`
                          const promise = appSdk.apiRequest(storeId, resource, 'PATCH', { invoices: update })
                          promises.push(promise)
                        }
                      }

                      if (sync.bling.financial_status) {
                        const blingStatus = trigger.situacao.toLowerCase()
                        const current = parseStatus(blingStatus)
                        if (
                          current &&
                          (!order.financial_status || order.financial_status.current !== current)
                        ) {
                          const url = `/orders/${order._id}.json`
                          const updatedAt = new Date().toISOString()
                          const data = {
                            financial_status: {
                              updated_at: updatedAt,
                              current
                            }
                          }
                          if (
                            blingStatus === 'atendido' &&
                            (!order.fulfillment_status || order.fulfillment_status.current !== 'delivered')
                          ) {
                            data.fulfillment_status = {
                              updated_at: updatedAt,
                              current: 'shipped'
                            }
                          }
                          if (!order.hidden_metafields || order.hidden_metafields.length < 100) {
                            const metafield = {
                              _id: randomObjectId(),
                              namespace: 'bling',
                              field: 'order-status-sync',
                              value: `${blingStatus} => ${current} (${updatedAt})`
                            }
                            data.hidden_metafields = !order.hidden_metafields ? [metafield]
                              : order.hidden_metafields.concat([metafield])
                          }
                          promises.push(appSdk.apiRequest(storeId, url, 'PATCH', data))
                        }
                      }

                      if (sync.bling.shipping_lines) {
                        if (trigger.transporte && trigger.transporte.volumes && order.shipping_lines) {
                          const codes = []

                          trigger.transporte.volumes.forEach(volume => {
                            if (volume.volume && volume.volume.codigoRastreamento) {
                              codes.push({
                                codigo: volume.volume.codigoRastreamento,
                                tag: volume.volume.servico.replace(/[^a-zA-Z0-9]/gis, '')
                              })
                            }
                          })

                          if (codes.length) {
                            const updateCodes = []
                            codes.forEach(code => {
                              updateCodes.push({
                                code: code.codigo,
                                tag: code.tag.replace(' ', '').toLowerCase()
                              })
                            })
                            const resource = `/orders/${order._id}` +
                              `/shipping_lines/${order.shipping_lines[0]._id}.json`
                            const promise = appSdk.apiRequest(storeId, resource, 'PATCH', {
                              tracking_codes: updateCodes
                            })
                            promises.push(promise)
                          }
                        }
                      }
                    }

                    return Promise.all(promises).then(() => {
                      logger.log(`Pedido ${trigger.numero} alterado via bling | store #${storeId}`)
                    })
                  })
                  .catch(error => {
                    const { message } = error
                    const payload = {}
                    if (error.response) {
                      delete error.config.headers
                      if (error.response.data) {
                        payload.data = error.response.data
                      }
                      payload.status = error.response.status
                      payload.config = error.config
                    }

                    database.logger.error([{
                      message,
                      resource_id: trigger.codigo,
                      store_id: storeId,
                      resource: payload && payload.config ? payload.config.url : '',
                      operation: 'Webhook Bling>Ecom',
                      payload: JSON.stringify(payload)
                    }])

                    logger.error('BlingUpdateErr', payload)
                  })
                processQueue.splice(processQueue.indexOf(trigger.numero), 1)
              }, Math.random() * (5000 - 1000) + 1000)
            }
          }
        }
        // all done
        res.send(ECHO_SUCCESS)
      })

      .catch(err => {
        if (err.name === SKIP_TRIGGER_NAME) {
          // trigger ignored by app configuration
          res.send(ECHO_SKIP)
        } else {
          // logger.error(err)
          // request to Store API with error response
          // return error status code
          // se responder com erro a api para de se comunicar com o app

          res.status(200)
          const { message } = err
          res.send({
            error: ECHO_API_ERROR,
            message
          })
        }
      })
  }
}

const parseStatus = status => {
  switch (status) {
    case 'em aberto':
    case 'em andamento':
    case 'em digitação':
      return 'pending'
    case 'venda agenciada':
    case 'atendido':
      return 'paid'
    case 'cancelado':
      return 'voided'
  }
  return null
}
