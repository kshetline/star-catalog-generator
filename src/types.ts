export interface StarInfo {
  fk5Num: number; // as int
  bscNum: number; // as int
  hipNum: number; // as int
  ngcIcNum: number; // as int
  flamsteed: number; // as byte
  bayerRank: number; // as byte
  subIndex: number; // as byte
  constellation: number; // as byte
  ngcIcClass: number; // as byte
  messierNum: number; // as byte
  name: string;
  RA: number;
  DE: number;
  pmRA: number; // as float
  pmDE: number; // as float
  vmag: number; // as float
}

export interface NGCMatchInfo {
  ngcIcNum: number;
  messierNum: number;
  name: string;
}

export type CrossIndex = Record<number, number>;
export type StarIndex = Record<number, StarInfo>;
