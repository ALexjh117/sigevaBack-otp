import type { HttpContext } from '@adonisjs/core/http'
import ValidacionVoto from '#models/validacion_voto'
import vine from '@vinejs/vine'
import { nanoid } from 'nanoid'
import { DateTime } from 'luxon'
import mail from '@adonisjs/mail/services/main'

export default class ValidacionVotoController {
  
  /**
   * Obtener todas las validaciones de voto
   */
  async index({ response }: HttpContext) {
    try {
      const validaciones = await ValidacionVoto.query()
        .preload('aprendiz')
        .preload('eleccion')
        .orderBy('id', 'desc')
      
      return response.status(200).json({
        message: 'Validaciones obtenidas exitosamente',
        data: validaciones
      })
    } catch (error) {
      return response.status(500).json({
        message: 'Error al obtener las validaciones',
        error: error.message
      })
    }
  }
  /**
   * Obtener una validación específica
   */
  async show({ params, response }: HttpContext) {
    try {
      const validacion = await ValidacionVoto.query()
        .where('id', params.id)
        .preload('aprendiz')
        .preload('eleccion')
        .first()

      if (!validacion) {
        return response.status(404).json({
          message: 'Validación no encontrada'
        })
      }

      return response.status(200).json({
        message: 'Validación obtenida exitosamente',
        data: validacion
      })
    } catch (error) {
      return response.status(500).json({
        message: 'Error al obtener la validación',
        error: error.message
      })
    }
  }

  /**
   * Generar OTP para votación
   * Endpoint: POST /api/validaciones/generar-otp
   */
  async generarOtp({ request, response }: HttpContext) {
    try {
      // Validación de datos de entrada
      const validator = vine.compile(
        vine.object({
          aprendiz_idaprendiz: vine.number().positive(),
          elecciones_ideleccion: vine.number().positive()
        })
      )

      const data = await request.validateUsing(validator)

      // 1. Verificar que el aprendiz existe y está activo
      const aprendiz = await (await import('#models/aprendiz')).default
        .query()
        .where('idaprendiz', data.aprendiz_idaprendiz)
        .preload('centro_formacion')
        .first()

      if (!aprendiz) {
        return response.status(404).json({
          message: 'El aprendiz especificado no existe',
          codigo_error: 'APRENDIZ_NO_ENCONTRADO'
        })
      }

      if (aprendiz.estado !== 'activo') {
        return response.status(400).json({
          message: 'El aprendiz debe estar en estado activo para votar',
          codigo_error: 'APRENDIZ_INACTIVO'
        })
      }

      // 2. Verificar que la elección existe y está activa
      const eleccion = await (await import('#models/eleccione')).default
        .query()
        .where('ideleccion', data.elecciones_ideleccion)
        .preload('centro')
        .first()

      if (!eleccion) {
        return response.status(404).json({
          message: 'La elección especificada no existe',
          codigo_error: 'ELECCION_NO_ENCONTRADA'
        })
      }

      // 3. Verificar fechas de la elección
      const fechaActual = new Date()
      const fechaInicio = new Date(eleccion.fecha_inicio)
      const fechaFin = new Date(eleccion.fecha_fin)

      if (fechaActual < fechaInicio) {
        return response.status(400).json({
          message: 'La elección aún no ha comenzado',
          codigo_error: 'ELECCION_NO_INICIADA',
          detalles: {
            fecha_inicio: eleccion.fecha_inicio,
            fecha_actual: fechaActual.toISOString().split('T')[0]
          }
        })
      }

      if (fechaActual > fechaFin) {
        return response.status(400).json({
          message: 'La elección ya ha finalizado',
          codigo_error: 'ELECCION_FINALIZADA',
          detalles: {
            fecha_fin: eleccion.fecha_fin,
            fecha_actual: fechaActual.toISOString().split('T')[0]
          }
        })
      }

      // 4. Verificar que pertenecen al mismo centro de formación
      if (aprendiz.centro_formacion_idcentro_formacion !== eleccion.idcentro_formacion) {
        return response.status(400).json({
          message: 'El aprendiz y la elección deben pertenecer al mismo centro de formación',
          codigo_error: 'CENTRO_FORMACION_DIFERENTE'
        })
      }

      // 5. Contar candidatos en la elección para información
      const totalCandidatos = await (await import('#models/candidatos')).default
        .query()
        .where('ideleccion', data.elecciones_ideleccion)
        .count('* as total')

      // 6. Verificar que el aprendiz no haya votado ya en esta elección
      const yaVoto = await ValidacionVoto.query()
        .where('aprendiz_idaprendiz', data.aprendiz_idaprendiz)
        .where('elecciones_ideleccion', data.elecciones_ideleccion)
        .first()

      if (yaVoto) {
        return response.status(400).json({
          message: 'Ya has votado en esta elección',
          codigo_error: 'YA_VOTO',
          detalles: {
            fecha_voto: yaVoto.createdAt,
            codigo_validacion: yaVoto.codigo
          }
        })
      }

      // 7. Generar código OTP único
      const otpCode = nanoid(6).toUpperCase() // Código de 6 caracteres
      
      // 8. Configurar tiempo de expiración (usaremos created_at + minutos)
      const expirationMinutes = parseInt(process.env.OTP_EXPIRATION_MINUTES || '5')

      // Crear registro temporal de validación con OTP
      await ValidacionVoto.create({
        codigo: `OTP_${otpCode}`,
        aprendiz_idaprendiz: data.aprendiz_idaprendiz,
        elecciones_ideleccion: data.elecciones_ideleccion
      })

      // 9. Enviar email con OTP
      console.log('🔧 Configuración SMTP:', {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        username: process.env.SMTP_USERNAME,
        from: process.env.MAIL_FROM_ADDRESS,
        to: aprendiz.email
      })

      try {
        console.log(`📧 Intentando enviar email OTP a: ${aprendiz.email}`)
        
        await mail.send((message) => {
          message
            .to(aprendiz.email)
            .from(process.env.MAIL_FROM_ADDRESS || 'noreply@sigeva.com')
            .subject('Código OTP para Votación - SIGEVA')
            .html(`
              <h2>Código OTP para Votación</h2>
              <p>Hola ${aprendiz.nombres} ${aprendiz.apellidos},</p>
              <p>Tu código OTP es: <strong style="font-size: 24px; color: #007bff;">${otpCode}</strong></p>
              <p>Este código expira en ${expirationMinutes} minutos.</p>
            `)
        })
        
        console.log(`✅ Email OTP enviado exitosamente a: ${aprendiz.email}`)
      } catch (emailError) {
        console.error('❌ Error completo enviando email OTP:', {
          error: emailError.message,
          code: emailError.code,
          command: emailError.command,
          response: emailError.response,
          responseCode: emailError.responseCode
        })
        // No fallar la operación si el email falla, pero registrar el error
      }

      // Respuesta base
      const responseData: any = {
        otp_generado: true,
        email_enviado_a: aprendiz.email,
        expira_en_minutos: expirationMinutes,
        eleccion: {
          nombre: eleccion.nombre,
          centro: eleccion.centro?.centro_formacioncol,
          total_candidatos: totalCandidatos[0]?.$extras?.total || 0
        },
        aprendiz: {
          nombre: `${aprendiz.nombres} ${aprendiz.apellidos}`,
          centro: aprendiz.centro_formacion?.centro_formacioncol
        }
      }

      // Solo incluir OTP en desarrollo (NODE_ENV !== 'production')
      if (process.env.NODE_ENV !== 'production') {
        responseData.codigo_otp_temporal = otpCode
        responseData._desarrollo_nota = "El código OTP se incluye solo en desarrollo. En producción, obtenerlo del email."
      }

      return response.status(200).json({
        message: 'Código OTP generado exitosamente',
        data: responseData
      })

    } catch (error) {
      return response.status(500).json({
        message: 'Error al generar OTP',
        error: error.message
      })
    }
  }

  /**
   * Validar código OTP (NO registra voto)
   */
  async validarOtp({ request, response }: HttpContext) {
    try {
      const validator = vine.compile(
        vine.object({
          codigo_otp: vine.string().minLength(6).maxLength(6),
          aprendiz_idaprendiz: vine.number().positive(),
          elecciones_ideleccion: vine.number().positive()
        })
      )

      const data = await request.validateUsing(validator)

      // 1. Buscar la validación temporal con el OTP
      const validacionTemporal = await ValidacionVoto.query()
        .where('codigo', `OTP_${data.codigo_otp}`)
        .where('aprendiz_idaprendiz', data.aprendiz_idaprendiz)
        .where('elecciones_ideleccion', data.elecciones_ideleccion)
        .first()

      if (!validacionTemporal) {
        return response.status(400).json({
          message: 'Código OTP inválido o no coincide',
          codigo_error: 'OTP_INVALIDO'
        })
      }

      // 2. Verificar que el OTP no haya expirado (usando created_at)
      const tiempoActual = DateTime.now()
      const expirationMinutes = parseInt(process.env.OTP_EXPIRATION_MINUTES || '5')
      const tiempoExpiracion = validacionTemporal.createdAt.plus({ minutes: expirationMinutes })
      
      if (tiempoActual > tiempoExpiracion) {
        // Eliminar OTP expirado
        await validacionTemporal.delete()
        
        return response.status(400).json({
          message: 'El código OTP ya expiró. Solicita uno nuevo.',
          codigo_error: 'OTP_EXPIRADO',
          detalles: {
            creado_en: validacionTemporal.createdAt.toISO(),
            expiro_en: tiempoExpiracion.toISO(),
            tiempo_actual: tiempoActual.toISO(),
            minutos_expiracion: expirationMinutes
          }
        })
      }

      // 3. Marcar el OTP como usado (cambiar prefijo)
      await validacionTemporal.merge({
        codigo: `USED_${data.codigo_otp}` // Marcar como usado
      }).save()


      return response.status(200).json({
        message: 'Código OTP validado correctamente',
        data: {
          otp_validado: true,
          aprendiz_id: data.aprendiz_idaprendiz,
          eleccion_id: data.elecciones_ideleccion,
          mensaje: 'Ahora puedes proceder a votar usando el endpoint de votación'
        }
      })

    } catch (error) {
      return response.status(500).json({
        message: 'Error al validar el código OTP',
        error: error.message
      })
    }
  }
}