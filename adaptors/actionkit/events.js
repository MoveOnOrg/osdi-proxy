const moment = require('moment-timezone')
const format = 'YYYY-MM-DDTHH:mm:ss'
const zipcode_to_timezone = require('zipcode-to-timezone')
const cacher = require('../../lib').cacher('ak-event')

module.exports = (api, config) => {
  const osdiify = configureOsdify(api, config)
  const akify = configureAkify(api, config)

  return {
    count: async () => {
      const result = await api.get('event')
      return result.body.meta.total_count
    },
    findAll: async params => {
      const page = (params && params.page) || 0
      const reference = `all-${page}`

      return await cacher.fetch_and_update(
        reference,
        (async () => {
          const result = await api
            .get('event')
            .query({ _offset: page * 100, _limit: 100 })

          const { objects } = result.body

          const final = await Promise.all(objects.map(osdiify))
          return final
        })()
      )
    },
    one: async id => {
      const result = await api.get(`event/${id}`)
      const final = await osdiify(result.body)
      return final
    },
    create: async object => {
      object.organizer_id = await ensureUser(api, object.contact.email_address)
      const akified = await akify(object)

      const result = await api.post('event').send(akified)
      const split_location = result.headers.location.split('/')
      const event_id = split_location[split_location.length - 2]

      const for_field_creation = { id: event_id, fields: [] }

      const fields = Object.keys(akified).filter(key => key.startsWith('field'))

      await Promise.all(
        fields.map(attr =>
          setEventField(
            api,
            for_field_creation,
            attr.split('field_')[1],
            akified[attr]
          )
        )
      )

      const to_return = await api.get(`event/${event_id}`)
      return await osdiify(to_return.body)
    },
    edit: async (id, edits) => {
      const original = (await api.get(`event/${id}`)).body
      const akified = await akify(edits, original)
      const fields = Object.keys(akified).filter(key => key.startsWith('field'))

      await Promise.all(
        fields.map(attr =>
          setEventField(api, original, attr.split('field_')[1], akified[attr])
        )
      )

      fields.forEach(f => {
        delete akified[f]
      })

      const result = await api.put(`event/${id}`).send(akified)

      return result.body
    },
    delete: async id => {
      return await api.put(`delete/${id}`)
    }
  }
}

function getEventField(ak, name) {
  const match = ak.fields.filter(field => field.name == name)[0]
  return match ? match.value : undefined
}

async function setEventField(api, ak, name, value) {
  const match = ak.fields.filter(field => field.name == name)[0]

  if (match) {
    return await api.put(match.resource_uri).send({ value })
  } else {
    return await api
      .post(`eventfield`)
      .send({ value, event: `/rest/v1/event/${ak.id}/`, name })
  }
}

function configureOsdify(api, config) {
  return async function osdify(ak) {
    return {
      id: ak.id,
      identifiers: [`actionkit:${ak.id}`],
      capacity: ak.max_attendees,
      location: {
        venue: ak.venue,
        address_lines: [ak.address1, ak.address2],
        locality: ak.city,
        region: ak.state,
        postal_code: ak.zip,
        location: [ak.latitude, ak.longitude]
      },
      browser_url: config.eventUrlBase + `/${ak.id}`,
      name: ak.title ? ak.title.toLowerCase().replace(/ /g, '-') : undefined,
      title: ak.title,
      start_date: ak.starts_at,
      end_date: ak.ends_at,
      description: ak.public_description,
      instructions: ak.directions,
      organizer_id: ak.creator.split('/')[4],
      status:
        ak.status == 'cancelled' || ak.status == 'deleted'
          ? ak.is_approved ? 'cancelled' : 'rejected'
          : ak.is_approved ? 'confirmed' : 'tentative',

      type: getEventField(ak, 'type') || 'Unknown',
      tags: getEventField(ak, 'tags')
        ? JSON.parse(getEventField(ak, 'tags'))
        : [],
      contact: {
        email_address: getEventField(ak, 'contact_email_address'),
        phone_number: getEventField(ak, 'contact_phone_number'),
        name: getEventField(ak, 'contact_name')
      }
    }
  }
}

function filterUndefined(obj) {
  return Object.keys(obj).reduce((acc, key) => {
    if (obj[key] !== undefined) {
      const addition = {}
      addition[key] = obj[key]
      return Object.assign(acc, addition)
    } else {
      return acc
    }
  }, {})
}

function configureAkify(api, config) {
  return async function akify(osdi, existing) {
    const time_zone =
      osdi.location && osdi.location.time_zone
        ? osdi.location.time_zone
        : zipcode_to_timezone.lookup(
            (osdi.location && osdi.location.postal_code) || existing.zip
          )

    const result = filterUndefined({
      address1: osdi.location
        ? osdi.location.address_lines
          ? osdi.location.address_lines[0]
          : undefined
        : undefined,

      address2: osdi.location
        ? osdi.location.address_lines
          ? osdi.location.address_lines[1]
          : undefined
        : undefined,

      city: osdi.location ? osdi.location.locality : undefined,
      state: osdi.location ? osdi.location.region : undefined,
      venue: osdi.location ? osdi.location.venue : undefined,
      public_description: osdi.description,
      directions: osdi.instructions,
      county: 'United States',
      zip: osdi.location ? osdi.location.postal_code : undefined,
      is_approved: osdi.status ? osdi.status == 'confirmed' : undefined,
      title: osdi.title,
      status: {
        confirmed: 'active',
        tentative: 'active',
        rejected: 'cancelled',
        cancelled: 'deleted'
      }[osdi.status],
      creator: osdi.organizer_id
        ? `/rest/v1/user/${osdi.organizer_id}/`
        : undefined,
      campaign: `/rest/v1/campaign/${config.defaultCampaign}/`,
      max_attendees: osdi.capacity,
      starts_at: osdi.start_date
        ? moment.tz(osdi.start_date, time_zone).format(format)
        : undefined,
      ends_at: osdi.start_date
        ? moment.tz(osdi.end_date, time_zone).format(format)
        : undefined,
      field_tags: osdi.tags ? JSON.stringify(osdi.tags) : undefined,
      field_type: osdi.type,
      host_is_confirmed: true,
      field_contact_email_address: osdi.contact
        ? osdi.contact.email_address
        : undefined,
      field_contact_phone_number: osdi.contact
        ? osdi.contact.phone_number
        : undefined,
      field_contact_name: osdi.contact ? osdi.contact.name : undefined
    })

    return result
  }
}

async function ensureUser(api, email_address) {
  const found = await api.get('user').query({ email: email_address })

  let creator = found.body.objects[0] ? found.body.objects[0].id : undefined

  if (creator === undefined) {
    const created = await api.post('user').send({ email: email_address })

    const split_location = created.headers.location.split('/')
    const created_at = split_location[split_location.length - 2]
    creator = created_at
  }

  return creator
}
