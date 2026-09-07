import winston from 'winston';

/**
 * Logging.
 *
 * JSON in production because Render aggregates stdout and a human-readable line
 * is not searchable there; coloured single lines in development because that is
 * what a person staring at a terminal can actually read.
 *
 * Silent under jest. A suite that prints boot logging for every file buries the
 * assertion that failed, and `console.log` is banned by eslint precisely so this
 * stays the one place output is decided.
 */

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const developmentFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf((info) => {
    const scope = info['scope'] ? ` [${info['scope']}]` : '';
    return `${info['timestamp']} ${info.level}${scope} ${info['message']}`;
  })
);

const productionFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  format: isProduction ? productionFormat : developmentFormat,
  transports: [new winston.transports.Console()],
  silent: nodeEnv === 'test',
});

/**
 * A child logger tagged with the subsystem, so a line from the till can be told
 * apart from a line from the gateway without reading the message.
 */
export function scoped(name: string): winston.Logger {
  return logger.child({ scope: name });
}
